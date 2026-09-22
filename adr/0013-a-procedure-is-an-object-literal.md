---
status: accepted
date: 2026-09-22
decision-makers: Jeremy Jonas
---

# A procedure is an object literal

## Context and Problem Statement

A procedure is the layer a consumer touches most, so how it is written is a requirement rather than a preference. Three styles were open: an object literal, a chained builder, or a class whose methods are its steps.

## Considered Options

* **An object literal** — `procedure({ … })`
* **A chained builder** — `define(name).input(…).…​.build()`
* **A class whose methods are the steps** — `class Review extends Procedure { … }`

## Decision Outcome

Chosen option: **the object literal**. All three catch a wrong composition at compile time, so safety does not separate them; the literal wins on the two things that do.

* **The declaration is the resolved configuration.** It is readable as data with no call, so the card generator and any tool that reads procedures need construct nothing. A builder resolves at `.build()`; a class needs instantiation *and* a method call.
* **A class makes losing a house guardrail expressible.** A subclass overriding `guardrails()` to return `[]` silently drops every inherited one and the compiler accepts it. In a literal the house set is concatenated by the helper and a procedure cannot reach past it, so replacing rather than adding has to be explicit at the call site.
* **Decorators are available and unused.** They work on the toolchain, but registration at module load is all they buy, and an exported literal is already discoverable through the same import graph.

### Consequences

* Good, because a guardrail cannot be lost to composition — the failure is unexpressible rather than tested for
* Good, because a reviewer reads two places: the literal, and the one helper that concatenates the house contributions
* Bad, because a procedure with many parts is verbose
* Neutral, because a builder is not foreclosed — both styles resolve to the same object, so one can be added later as sugar over the same declaration type
