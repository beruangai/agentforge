# How a procedure is written — spike findings

> **Superseded as a decision, retained as evidence.** §N was re-decided on 2026-09-22 in favour of adopting oRPC rather than hand-building an authoring style ([`procedure-framework.md`](procedure-framework.md), [ADR 0013](../../adr/0013-a-procedure-is-an-orpc-contract.md)). What is measured below still holds and two findings remain load-bearing: the class's silent `override guardrails()` hazard, which is why guardrail composition stays additive; and the decorator gate, which is verified platform behaviour whatever is built on it.

**Measured on 2026-09-22.** TypeScript 5 standard decorators on Bun 1.4.0, `tsc` with `--strict`. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §N. No model spend.

Source: `spikes/procedure-authoring/` (retired at A0; git history `d3f08b7`) — a baseline inferred from both consumers, the same five procedures authored in all three candidate styles, and a judge that runs `tsc` over deliberately-wrong variants rather than arguing about them.

---

## The baseline

Five shapes, inferred from both consumers' contracts read on 2026-09-22 — representative, not exhaustive, chosen to expose the differences between the styles. Consumer domain vocabulary is deliberately absent (`ARCHITECTURE.md` §11): the shapes are borrowed, the nouns are not.

| Shape | Stresses | Serves |
|---|---|---|
| **minimal** | the floor — name, outer contract, agent contract, marshal, prompt, options | §REQ101 |
| **computed** | outer output carrying fields the model must never be asked for | §REQ102 |
| **phased** | before / after-success / after-failure, each seeing the prior attempt's state | §REQ205 |
| **guarded** | guardrails composed from several sources, additively, none dropped | §REQ204 |
| **discriminated** | a domain-level negative result returned as a **success** under its own discriminator | §REQ502 |

## The gate: decorators on Bun

§N made decorator registration conditional on the toolchain. It is **clean**, so decorators are available to any style on merit rather than excluded on toolchain grounds:

- **Standard TypeScript 5 decorators run on Bun 1.4.0** — method and class decorators both applied and invoked.
- **Inference survives the decorated member.** Proved with `@ts-expect-error`: with a decorator applied, `const bad: string = returned.length` still errors and `step({ wrong: 1 })` still errors. Had the decorator widened the member to `any`, both directives would have reported as unused. They did not.
- **`Symbol.metadata` is undefined on Bun 1.4.0**, so decorator metadata needs the one-line polyfill `Symbol.metadata ??= Symbol('Symbol.metadata')`, loaded before any decorated module. With it, `context.metadata` writes read back off the class correctly.
- **A class decorator registers at module load** — which is the only thing registration buys over an explicit call, and it carries a cost: the registry only contains what something imported, which a build-time card generator must account for.

## Criterion 1 — does a wrong composition fail at compile time?

Six mistakes a procedure author will actually make, each written in all three styles and fed to `tsc --strict`. A style scores only when `tsc` **rejects** it.

| Probe | n1 literal | n2 builder | n3 class |
|---|---|---|---|
| marshal returns the wrong shape (forgets a computed field) | caught | caught | caught |
| prompt reads a field the input does not have | caught | caught | caught |
| no marshal at all, though the two contracts differ | caught | caught | caught |
| no prompt at all | caught | caught | caught |
| no agent contract at all | caught | caught | caught |
| an after-phase reads a field of the *agent* output, not the outer one | caught | caught | caught |
| **total** | **6/6** | **6/6** | **6/6** |

**All three are equally safe on composition, which is the result that decides the question** — because it removes the only advantage §N credited to the builder. `.build()` reachable solely on a complete builder is real, but the object literal's own parameter type already requires the same parts, and gets there without a 150-line class of `this`-typed methods and internal `as any` casts.

> One probe initially scored n3 at 5/6. The n3 variant had an `as any` the other two did not — an unfair comparison, and my own error. Corrected, and it scores 6/6. Recorded because a 5-versus-6 would have decided this question on an artefact of how the test was written.

## Criterion 2 — is the resolved configuration inspectable without executing it?

| | How the resolved object is obtained |
|---|---|
| **n1 literal** | **the declaration *is* the resolved object.** Readable as data, no call |
| n2 builder | resolved at `.build()`, at module load; data thereafter |
| n3 class | **`new Draft().resolve()`** — instantiation *and* a method call |

All three produce the same resolved value (4 guardrails each, same options), so this is about access, not outcome. n3 is the only one where a tool that wants to read procedures — a card generator, a registry dump, a review script — must construct objects to do it.

## Criterion 3 — the override hazard, made concrete

§N's stated risk for n3 was "that overriding rather than contributing becomes the habit." That is measurable, and it is worse than a habit.

```ts
override guardrails(): readonly Guardrail[] { return []; }
```

A subclass returning `[]` **silently drops every house guardrail**. `tsc` accepts it: the probe was **not caught**. Nothing in the type system objects, and nothing at runtime notices, because the base class's contribution was never a separate thing — it was the default return value of a method that has now been replaced.

**In n1 and n2 the same mistake is not expressible.** The house set is concatenated by the helper, and a procedure has no way to reach past it; replacing rather than adding would have to be an explicit call at the site, which is exactly the property §REQ204 and `ARCHITECTURE.md` §3 ask for.

n3 also costs on criterion 3 directly: knowing a procedure's full guardrail set means reading the subclass, the base class, and every class in between, whereas n1 and n2 each have exactly two places — the declaration and the one helper.

## The decision

**N1, the object literal.** It ties on safety, wins on inspectability, and is the only one of the three where losing a guardrail to composition is unexpressible rather than merely discouraged.

Recorded at the time as ADR 0013; that ADR was re-decided on 2026-09-22 and is now [a procedure is an oRPC contract](../../adr/0013-a-procedure-is-an-orpc-contract.md).

**N2 is not wrong, it is unearned.** Its one claimed advantage — making an invalid composition a compile error — is matched by n1 without the machinery. If a procedure with many parts ever reads badly as a literal, a builder can be added later as sugar over the same declaration type, because both resolve to the same object. Nothing about choosing n1 now forecloses it.

**N3 is rejected on the hazard**, not on taste. The argument for it — familiarity and discoverability — is real, and does not outweigh a composition mistake the compiler cannot see.

**Decorators are available but not needed.** They are clean on this toolchain, and registration at module load is the only thing they buy. An object literal exported from a module is already discoverable by the same import graph, without the `Symbol.metadata` polyfill and without a registry whose contents depend on what happened to be imported.

---

## Why the baseline has no agent-less procedure

**TrendBot's draft asked for procedures that invoke no agent** — vault reads, corpus scans, snapshot and publish composers, measurement runs of up to an hour — sharing a procedure's contract, invocation, failure and side-effect phases, minus the run.

AgentForge **does not carry agent-less procedures**, and this was settled before the spike: `ARCHITECTURE.md` §11 and `SOLUTION_SPACE.md` both list them as deliberately absent. AgentForge runs agents; a consumer's plain work belongs in the consumer.

**Confirmed by the operator on 2026-09-22**, on being asked: §11 stands, and TrendBot uses another mechanism for its non-agentic work, which is trivial for it.

So the baseline covers agent runs only, and the five shapes above are the whole surface a procedure has.
