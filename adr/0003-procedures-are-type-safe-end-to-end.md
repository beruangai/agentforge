---
status: proposed
date: 2026-09-19
decision-makers: Jeremy Jonas
---

# Procedures are type-safe end to end

## Context and Problem Statement

A workflow calls a procedure by name with an input and gets an output back. Both consumers require that a wrong name or a mismatched shape fails at compile time, with no per-procedure client wiring (H1, H2, T1). The output the agent produces is often not the output the caller needs. And the container answering a call may be running code older than the worker's. How are procedures declared and invoked?

## Considered Options

* **An RPC framework** — tRPC or similar, with a generated or federated client
* **Schema-only, validated at run time** — a name and a Zod schema, checked in the container
* **Typed data in two halves** — a contract the worker imports, an implementation the container registers

## Decision Outcome

Chosen option: **typed data in two halves**, because the call is asynchronous — the outcome is read from durable state rather than returned by the call — which leaves an RPC framework's request-response typing with nothing to type, while a contract imported directly gives the worker exactly the types it needs.

* The **contract** is the name, outer input and output schemas, and a hash; it depends on Zod alone, so importing it never pulls the Agent SDK into a worker bundle
* The **implementation** registers against that contract in the container
* **Outer and agent contracts are separate**, with a marshal step between them: computed fields and identifiers are added there, never asked of the model (H8, T18)
* The **contract hash** travels in the envelope; a container that does not implement it refuses the task before any work (H3, T3)
* Strict parsing at every boundary — an undeclared field is rejected, never dropped (T16)

### Consequences

* Good, because nothing sits between the wire and the procedure, and there is no client to generate
* Good, because version skew fails loudly at the start of a task instead of midway
* Bad, because the contract and implementation split is a layout rule to hold; importing an implementation into a worker would pull the SDK into its bundle
