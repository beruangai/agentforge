---
status: accepted
date: 2026-09-19
decision-makers: Jeremy Jonas
---

# Four layers, with a contract at every boundary

## Context and Problem Statement

A harness for Claude agents behind durable workflows mixes concerns that fail differently: a transport to an isolated runtime, the execution of one agent run, and the use case being served. Where they are one layer, an intermittent failure has no owner and each fix is made wherever it surfaced. What structure keeps a failure fixable in one place?

## Considered Options

* **One layer** — transport, execution control, and use case together; whatever is fastest to change
* **Two layers** — a transport and everything else
* **Four layers with an explicit contract at each boundary** — runtime, harness, consumer, SDK

## Decision Outcome

Chosen option: **four layers, each meeting the next at a named contract**, because a boundary is only real when what crosses it is defined, and a layer is only testable alone when it can be exercised through that contract.

* Runtime owns the wire, the task's execution host, and its durable state; harness owns the procedure model and one agent run; the consumer owns procedures and identifiers; the SDK — the agent SDK of the project's **framework** — owns the agent loop. Each framework has its own part of the layers, beside the shared ones, and the layer rules hold inside it ([ADR 0021](0021-an-agentic-project-chooses-its-framework.md)). *(Amended 2026-10-22: layer 4 was the Claude Agent SDK alone.)*
* **Layers 1 and 2 never import each other.** They share two things, both schemas and types and neither an implementation of either layer: the **task protocol**, and the **procedure contract** — an oRPC contract over Zod, the single source of truth every seam is typed by. A caller's client is typed by it, the task process checks its hash before any work, and an implementation registers against it
* The consumer's task entrypoint is the single place the two are wired together
* **Two crossings are protocols** — the wire between caller and agent, and the IPC channel between executor and task process. The client API, the task store and the bundle are interfaces inside a layer and get no ceremony (`docs/ARCHITECTURE.md` §1)
* Nothing above the task process knows what a task runs: a framework-aware executor would put the SDK back into the transport layer, which is the mixing this decision exists to prevent. The server takes only its framework's server part — required secrets and telemetry — from the consumer's server entry

### Consequences

* Good, because the harness runs against a fixture with no container, and the runtime runs a task whose process is a stub
* Good, because a failure is reproduced as a test in the layer that owns it
* Bad, because a change crossing a boundary costs a protocol change, not an import
