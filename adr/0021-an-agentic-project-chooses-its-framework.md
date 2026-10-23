---
status: accepted
date: 2026-10-22
decision-makers: Jeremy Jonas
---

# An agentic project chooses its framework

## Context and Problem Statement

AgentForge's boundary knows nothing of Claude: the A2A wire, typed procedures, the gateway, the executor, durable task state, filesystems, the client and the Temporal activity. The agent loop beneath it, though, is fixed to the Claude Agent SDK.

The operator wants more than one **framework** — the agent SDK a project's runs go through — each for the use case it fits. This is not a migration from one to another; both stay:

- the Claude Agent SDK (`claude`) for agentic coding, where Claude Code's tools matter most;
- Strands Agents (`strands`) for non-coding work, for lower-level control of the loop.

A project's guardrails, hooks, tools and base layer are written for its framework, and none of them carries over to another. Where is the framework chosen, where does its code live, and how does an image carry it? And is the seam built now, with one framework, or with the second?

## Considered Options

* **Per agentic project, each framework a self-contained folder with its own image**
* **Per agent, one AgentForge image carrying every framework**
* **A run-time switch** read by the server or the task process

When:

* **The whole seam now** — interface, stub, image split and plugin record — with `claude` the only framework
* **The consumer surface now, the seam with the second framework**

## Decision Outcome

Chosen option: **per agentic project, each framework a self-contained folder with its own image.** The operator chose it on 2026-10-22. A solution holding both frameworks has two projects, coding agents and non-coding agents.

- **Where the code lives.** AgentForge's current modules (`core/`, `server/runtime/`, `server/harness/`, `client/`, `infra/`, `plugin/`) are the shared base. Each framework lives in `src/framework/<name>/`, with nested `harness/`, `server/`, `client/`, `infra/`, `plugin/` and so on, only as it needs them. Shared modules never import a framework, with one exception: the plugin reaches each provided framework's `plugin/` part through one registry, `src/framework/registry.ts`. A framework never imports another, and the layer rules (runtime ↛ harness) hold inside each framework as they do outside.
- **How it is chosen.** The project's metadata names its framework: `claude` by default, and the only one until a second is built. The plugin renders, from that framework's `plugin/` part, the base layer `FROM` its image, the procedures' scaffolds, options and secrets, the server entry, and the constructs.
- **How procedures bind to it.** Each framework has its own entry points beside the shared `/agent`, so a procedure written for one framework does not compile against another.
- **Where it meets the runtime.** A framework meets the runtime only in the consumer's server entry, which passes the framework's server part. Layers 1 and 2 are unchanged in what they own; the framework is what layer 2's `runAgent` calls.
- **Images.** Each framework has its own `Dockerfile` in its folder. What the frameworks share stays in AgentForge's current `Dockerfile`, as the base the framework images compose with.
- **When.** The whole seam is built now, with `claude` the only framework; the operator chose it on 2026-10-22, so StrategyFoundry develops against a framework-agnostic AgentForge and a second framework is additive, with no refactor in any consumer. It departs knowingly from "seams, not speculative abstractions — an interface earns its place with a second implementation". The mitigations: a typechecked Strands stub with concrete types of its own, unregistered and unexported; and `strands-framework` reshapes the interface where Strands needs it. On the same day the operator ruled that StrategyFoundry, bootstrapped locally and not yet customised, does not yet depend on ADRs 0001, 0008, 0015 and 0018, so they are mutated in place.

### Consequences

* Good, because each image carries only its framework. A Strands image has no Claude binary; a Claude image has no Strands SDK.
* Good, because a framework is read, changed and removed as one folder, and its boundary is enforced by lint.
* Good, because a project's guardrails, hooks and tools are written once, for the one framework they run under.
* Good, because a wrong pairing is a compile error, never a run-time branch, and the runtime stays agnostic of what a task runs (ADR 0001).
* Bad, because work that wants both frameworks spans two projects, and a workflow calls each.
* Bad, because the package ships a consumer surface and an image per framework, each needing its own example and live tiers.

## Pros and Cons of the Options

### Per agent, one image

* Good, because agents of one project could differ.
* Bad, because the base layer's guardrails, hooks, options and instructions would mean nothing to an agent on the other framework, so a project would share nothing but its name.
* Bad, because every image would carry every framework's peers.

### A run-time switch

* Bad, because a framework-aware server or executor puts the agent SDK back into layer 1, which ADR 0001 exists to prevent.
* Bad, because a procedure's options could not be typed by its framework.

### The whole seam now

* Good, because the consumer's breaking move happens once, while StrategyFoundry has one placeholder procedure.
* Good, because a second framework adds a folder and an image, and changes nothing a consumer wrote.
* Bad, because the interface is checked against one implementation and a stub.
* Bad, because the image splits into a base `agentforge/a2a` that only `agentforge/a2a-claude` uses, with a second lock and a framework image target in every consumer project.

### The consumer surface now, the seam with the second framework

* Good, because the interface and the base image are shaped by two real frameworks.
* Bad, because `strands-framework` would then rework the image chain, the plugin record and the generated entries, which sync re-renders in every consumer.
