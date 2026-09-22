---
status: proposed
date: 2026-09-22
decision-makers: Jeremy Jonas
---

# A procedure is an object literal

## Context and Problem Statement

A procedure is the layer a consumer touches most, so how it is written is a requirement rather than a preference ([ADR 0003](0003-procedures-are-type-safe-end-to-end.md)). Three styles were open: an object literal, a chained builder, or a class whose methods are its steps.

Settling it by argument would couple the answer to whoever argued last, and settling it against one consumer's real procedures would couple it to that consumer — AgentForge ships before StrategyFoundry's development starts. So it was settled against a **baseline inferred from both consumers' contracts**, authored in all three styles, and judged by running the compiler rather than by reading the code.

## Decision Drivers

§N named the three, and each was measured rather than asserted:

* whether a wrong composition fails at **compile time**
* whether the resolved configuration is **inspectable without executing** the declaration
* whether a reviewer sees everything a procedure contributes **without following an inheritance chain**

## Considered Options

* **N1 — object literal.** `procedure({ … })`
* **N2 — chained builder.** `define(name).input(…).…​.build()`
* **N3 — a class whose methods are the steps.** `class Review extends Procedure { … }`

## Decision Outcome

Chosen option: **N1, the object literal** ([research](../docs/research/procedure-authoring.md), `spikes/procedure-authoring/`).

**On safety the three are equal**, and that is the finding that decides it. Six mistakes a procedure author will actually make — a marshal that forgets a computed field, a prompt reading a field the input does not have, a missing marshal, a missing prompt, a missing agent contract, an after-phase reading the agent output instead of the outer one — were written in all three styles and fed to `tsc --strict`. **All three caught all six.** The builder's one claimed advantage, `.build()` reachable only on a complete builder, is matched by the literal's own parameter type, without a class of `this`-typed methods and internal `as any` casts.

**On inspectability the literal wins outright**: the declaration *is* the resolved object, readable as data with no call. The builder resolves at `.build()`. The class requires `new Draft().resolve()` — instantiation *and* a method call — so any tool that reads procedures, such as the build-time card generator, must construct objects to do it.

**On the third criterion the class has an unguarded hazard**, which is what rejects it. A subclass writing

```ts
override guardrails(): readonly Guardrail[] { return []; }
```

**silently drops every house guardrail, and `tsc` accepts it.** The base class's contribution was never a separate thing to lose — it was the default return value of a method that has now been replaced. In the literal and the builder the same mistake is not expressible: the helper concatenates, and a procedure cannot reach past it, so replacing rather than adding has to be explicit at the call site — which is precisely what D8 and `ARCHITECTURE.md` §3 require.

### Consequences

* **Good:** a guardrail cannot be lost to composition. The failure mode "a merge drops a hook" is unexpressible rather than tested for.
* **Good:** the resolved configuration is data. The card generator, a registry dump and a review script all read procedures without constructing anything.
* **Good:** a reviewer reads two places — the literal, and the one helper that concatenates the house contributions.
* **Bad:** a procedure with many parts is verbose, which is exactly the complaint §N raised against N1. Accepted: verbosity is visible, and the failure it trades against is not.
* **Neutral:** **N2 is not foreclosed.** Both styles resolve to the same object, so a builder can be added later as sugar over the same declaration type if verbosity becomes a real problem. It is rejected now as unearned, not as wrong.
* **Neutral:** **decorators are available and unused.** Standard TypeScript 5 decorators run on Bun 1.4.0 and preserve inference through the decorated member (proved with `@ts-expect-error`); `Symbol.metadata` is undefined and needs a one-line polyfill. Registration at module load is all they buy, and an exported literal is already discoverable through the same import graph — without the polyfill, and without a registry whose contents depend on what happened to be imported.

### Confirmation

The judge is promoted into the procedure capability's `integ/` (`ARCHITECTURE.md` §9). Its six probes are the regression: each one is a composition mistake that must stay a compile error, and a style change that lets any of them through is caught rather than discovered.

## More Information

The baseline covers **agent runs only**. TrendBot's T4 asks for procedures that invoke no agent; AgentForge does not carry it, which `ARCHITECTURE.md` §11 and [`CONSUMERS.md`](../docs/CONSUMERS.md)'s "does not carry" table already recorded, and which the operator confirmed on 2026-09-22 when the spike re-raised it. TrendBot's non-agentic work moves to its own API layer. So the five shapes the styles were judged against are the whole surface a procedure has.
