---
status: accepted
date: 2026-09-20
decision-makers: Jeremy Jonas
---

# AgentForge is consumed as an Nx plugin, and agents nest in one project

## Context and Problem Statement

A consumer adopting AgentForge has to scaffold a project, write a Dockerfile for an ARM64 image, wire an A2A server, provision an AgentCore runtime with its stores and IAM, publish bundles, and build a typed client for its callers. Done by hand, each consumer does it differently and drifts. `@aws/nx-plugin` already solves this shape for Strands agents — its `ts#agent` generator scaffolds the project, the A2A server, CDK constructs with `grantInvokeAccess`, and a client factory — but it is purpose-built for Strands, so another framework needs its own generator. How is AgentForge delivered, how are a consumer's several agents laid out, and what does a caller connect to?

## Considered Options

For delivery: **libraries plus documentation**, or **an Nx plugin following `@aws/nx-plugin`'s conventions**.

For layout: **one project per agent**, with a shared project holding the image and constructs, or **one agentic project holding several nested agents**.

For what a caller connects to: **each agent**, with its own client and construct as `@aws/nx-plugin` generates them, or **the agentic project**, with one client over its agents.

For keeping wiring current: **scaffold once** and leave upgrades to the consumer, **regenerate everything**, or **an ownership contract** between what AgentForge keeps current and what the consumer owns.

## Decision Outcome

Chosen: **an Nx plugin**, with **agents nested in one project**, **the project as what a caller connects to**, and **an ownership contract** kept by a sync generator (§REQ709).

* **Generators, executors and a sync generator are all part of it**, in the one package, versioned with the code they wire. `@aws/nx-plugin` already does this, so AgentForge extends its conventions — its component metadata, its shared constructs project, its runtime configuration — and composes its public generators rather than copying them
* Nesting follows the image layering ([ADR 0008](0008-code-ships-in-the-image.md)): a project holds one base layer and the agents that extend it, each agent keeping its own image and build targets, so a change rebuilds only the layer that contains it
* **An agent is a component of its project**, recorded once in the project's metadata; every piece of wiring that spans the project's agents is derived from those records
* **The project is what a caller connects to.** It vends one client over all its agents, typed by their contracts and built from a mapping of agent to runtime — local containers by name, or AgentCore runtimes resolved from the runtime configuration the deployment registers — so a caller never addresses a runtime by hand. Each agent has its own construct, deployed as its own AgentCore runtime — the strongest isolation available — and a project construct wraps them, registering each in the runtime configuration and granting a caller exactly the project's agents (§REQ708). Rejected: a client per agent, because a caller would wire each agent and each grant by hand, and the project is the unit its agents are designed and deployed as
* **Infrastructure is the consumer's.** The plugin generates the constructs; the consumer's infra project — `@aws/nx-plugin`'s `ts#infra` or its own — declares them where it wants them and configures them. The plugin never edits a stack or its checks
* **An ownership contract decides what an upgrade touches.** What AgentForge's version determines — Dockerfiles, entries, the project client, the constructs, targets, and named keys in shared manifests — is **maintained**: sync and regeneration keep it current. What the consumer writes — contracts, procedures, options, Claude configuration — is **scaffolded** once and never touched again. A consumer **detaches** any maintained artifact by naming it, and owns it from then on. Rejected: scaffolding once, because every AgentForge change would become hand-patching in every consumer; regenerating everything, because it destroys what the consumer wrote
* A separate project is right for an agent whose capabilities are unlike its neighbours', such as one adding Python and NautilusTrader (§REQ704); it extends the AgentForge image directly
* Worth taking from `@aws/nx-plugin`: one workspace-wide image registry rather than one per agent, constructs exposing a grant for callers, component metadata, and its runtime configuration

*(Amended 2026-09-29: added what a caller connects to — the project, through one client and a project construct over per-agent constructs — the ownership contract, and infrastructure left to the consumer.)*

### Consequences

* Good, because an agent's infrastructure comes from reviewed constructs rather than a folder copied from another consumer, and a caller connects to a project once
* Good, because the image is built once for a group of agents instead of once per agent
* Good, because an upgrade reaches what AgentForge owns and nothing else, and a consumer who needs to own something takes it explicitly
* Bad, because nesting makes build granularity a matter of targets rather than project boundaries, and a careless target rebuilds every agent in the project
* Bad, because generators are code to maintain and lag the libraries they scaffold unless a consumer exercises them — which the sync generator mitigates only if it is exercised on every release
* Bad, because a maintained artifact edited in place is reverted by the next sync; detaching is the only way to keep such an edit
