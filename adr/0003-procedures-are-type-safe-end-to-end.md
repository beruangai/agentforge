---
status: accepted
date: 2026-09-22
decision-makers: Jeremy Jonas
---

# Procedures are type-safe end to end

## Context and Problem Statement

A workflow calls a procedure by name with an input and gets an output back. A wrong name or a mismatched shape must fail at compile time, with no per-procedure client wiring (§REQ101). The output the agent produces is often not the output the caller needs. And the container answering a call may be running code older than the worker's.

**Invocation is asynchronous, which shapes the answer.** A start returns a task handle, never an outcome, so its output is the *same* for every procedure; a caller then polls, and may cancel. End-to-end type safety therefore needs **several typed procedures per declaration**, however they are produced — which is what the wire already has.

## Considered Options

* **An RPC framework** — a procedure builder with middleware, context and a generated client
* **Schema-only, validated at run time** — a name and a Zod schema, checked in the container
* **Hand-built typed data in two halves** — a contract the worker imports, an implementation the container registers

## Decision Outcome

Chosen option: **an RPC framework — oRPC, contract-first** — retaining the two halves as the packaging.

* A consumer declares **one contract**: a name, an input schema and an output schema, in Zod. A utility **derives the typed calls** — `SendMessage` and `GetTask` per procedure, `CancelTask` once at the root — named as A2A names them, so they are derived rather than written out
* The **contract** half is what a caller imports; the **implementation** half registers against it in the container, and an import of the implementation from a worker's build fails
* **Outer and agent contracts stay separate**, with a marshal step between them: computed fields and identifiers are added there, never asked of the model (§REQ102)
* The **contract hash** travels in the envelope; a container that does not implement it refuses the task before any work (§REQ104)
* Parsing against the contract at every boundary — input before the run, the agent's output before the handler sees it, the outer output before it leaves, and the output again in the caller (§REQ103)
* **The transport stays ours.** The client derives its calls from the contract and speaks A2A itself; oRPC contributes the contract and the in-container implementation, and no transport

## Consequences

* Good, because the three calls are generated from one declaration instead of being hand-written things that can drift from it or from each other
* Good, because `GetTask` returns a discriminated union on the task's state, so a caller reads a non-terminal state and reaches the output only where it exists
* Good, because typed middleware and an accumulating typed context come with the framework rather than being built and maintained here
* Bad, because the contract half now depends on `@orpc/contract` rather than on Zod alone, which a consumer must keep in step
* Bad, because the framework's major version is a dependency of the public type surface
