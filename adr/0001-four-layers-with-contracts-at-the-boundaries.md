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

* Runtime owns the wire, the task's execution host, and its durable state; harness owns the procedure model and one agent run; the consumer owns procedures and identifiers; the SDK owns the agent loop
* **Layers 1 and 2 never import each other.** They share two things, both schemas and types and neither an implementation of either layer: the **task protocol**, and the **procedure contract** — an oRPC contract over Zod, the single source of truth every seam is typed by. A caller's client is typed by it, the gateway checks its hash, and an implementation registers against it
* The consumer's task entrypoint is the single place the two are wired together
* **Two crossings are protocols** — the wire between caller and agent, and the pipe between executor and task process — because each joins separately deployed, separately versioned things. The client API, the task store and the bundle are interfaces inside a layer and get no ceremony (`docs/ARCHITECTURE.md` §1)
* Nothing above the task process knows what a task runs: a Claude-aware executor would put the SDK back into the transport layer, which is the mixing this decision exists to prevent

### Consequences

* Good, because the harness runs against a fixture with no container, and the runtime runs a task whose process is a stub
* Good, because a failure is reproduced as a test in the layer that owns it
* Bad, because a change crossing a boundary costs a protocol change, not an import
