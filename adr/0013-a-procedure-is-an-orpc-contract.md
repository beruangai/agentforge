---
status: accepted
date: 2026-09-22
decision-makers: Jeremy Jonas
---

# A procedure is an oRPC contract, split into A2A's own task calls

## Context and Problem Statement

A procedure is the layer a consumer touches most, so how it is written is a requirement rather than a preference. The original question compared three **hand-built** authoring styles — an object literal, a chained builder, or a class whose methods are its steps — and chose the literal, partly because the alternatives were machinery to build and maintain.

That comparison never asked whether the machinery had to be built at all. It also predated the realisation that **every procedure is really several**: because invocation is asynchronous, a start returns a handle and the caller then polls and may cancel — which is exactly the three task RPCs A2A already has, and the start's output schema is identical for every procedure.

## Considered Options

* **A hand-built object literal** — `procedure({ … })`, with the asynchronous call pattern handled implicitly and untyped
* **A hand-built chained builder or class**
* **oRPC, contract-first** — declare the contract, derive the calls

## Decision Outcome

Chosen option: **oRPC, contract-first**. A consumer declares one contract; a utility derives the two typed procedures.

* **The split is a utility, not a convention.** One contract in; **`SendMessage`** and **`GetTask`** out, named as A2A names them and typed with the procedure's own shapes rather than a shared opaque one. `GetTask` returns a **discriminated union on the task state**, so a poll answers a non-terminal task and the declared output is reachable only where it exists. **`CancelTask` is root-level**, not derived: a task id and a runtime session are the caller's, so nothing about it is the procedure's
* **A caller's per-call values are the client's context, not any procedure's input** — `runtimeSessionId` on every call, `idempotencyKey` on `SendMessage` alone, enforced by the client type AgentForge vends
* **Cross-cutting behaviour is middleware that contributes to a typed context.** A house helper resolves something and adds it; every later middleware and the handler see it typed, without the procedure declaring it. This is what the hand-built literal could not offer
* **Composite contributions stay additive** — hooks, MCP servers and denied tools concatenate, and replacing rather than adding is explicit at the call site, so no guardrail is lost to ordering
* **A procedure never names its transport.** The same declaration runs in-process and over a custom link

## Consequences

* Good, because the three calls cannot drift from the contract, or from each other — they are derived from it
* Good, because typed context composition is a solved problem taken off the shelf rather than a generics exercise maintained here
* Good, because the same procedures execute directly in-process, which is what a container answering a task needs
* Bad, because a consumer's declaration is now shaped by a third-party builder, and a major version of it is a migration
* Neutral, because the original comparison's finding still holds on its own terms: a class's `override guardrails()` can silently drop a house contribution with the compiler's blessing, which is why guardrail composition stays additive here
