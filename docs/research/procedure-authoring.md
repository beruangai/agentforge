# How a procedure is written — spike findings

**Measured on 2026-09-22.** TypeScript 5 standard decorators on Bun 1.4.0, `tsc` with `--strict`. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §N. No model spend.

Source: `spikes/procedure-authoring/` — a baseline inferred from both consumers, the same five procedures authored in all three candidate styles, and a judge that runs `tsc` over deliberately-wrong variants rather than arguing about them.

---

## The baseline

Five shapes, inferred from both consumers' contracts read on 2026-09-22 — representative, not exhaustive, chosen to expose the differences between the styles. Consumer domain vocabulary is deliberately absent (`ARCHITECTURE.md` §11): the shapes are borrowed, the nouns are not.

| Shape | Stresses | From |
|---|---|---|
| **minimal** | the floor — name, outer contract, agent contract, marshal, prompt, options | H1, H2, T1 |
| **computed** | outer output carrying fields the model must never be asked for | H principle 3, T18, D2 |
| **phased** | before / after-success / after-failure, each seeing the prior attempt's state | T33, T34, D33 |
| **guarded** | guardrails composed from several sources, additively, none dropped | H5, T8–T11, D8 |
| **discriminated** | a domain-level negative result returned as a **success** under its own discriminator | T19 |

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

**In n1 and n2 the same mistake is not expressible.** The house set is concatenated by the helper, and a procedure has no way to reach past it; replacing rather than adding would have to be an explicit call at the site, which is exactly the property D8 and `ARCHITECTURE.md` §3 ask for.

n3 also costs on criterion 3 directly: knowing a procedure's full guardrail set means reading the subclass, the base class, and every class in between, whereas n1 and n2 each have exactly two places — the declaration and the one helper.

## The decision

**N1, the object literal.** It ties on safety, wins on inspectability, and is the only one of the three where losing a guardrail to composition is unexpressible rather than merely discouraged.

Recorded as [ADR 0013](../../adr/0013-a-procedure-is-an-object-literal.md), status `proposed`.

**N2 is not wrong, it is unearned.** Its one claimed advantage — making an invalid composition a compile error — is matched by n1 without the machinery. If a procedure with many parts ever reads badly as a literal, a builder can be added later as sugar over the same declaration type, because both resolve to the same object. Nothing about choosing n1 now forecloses it.

**N3 is rejected on the hazard**, not on taste. The argument for it — familiarity and discoverability — is real, and does not outweigh a composition mistake the compiler cannot see.

**Decorators are available but not needed.** They are clean on this toolchain, and registration at module load is the only thing they buy. An object literal exported from a module is already discoverable by the same import graph, without the `Symbol.metadata` polyfill and without a registry whose contents depend on what happened to be imported.

---

## A conflict to raise, not design around

**TrendBot T4 asks for procedures that invoke no agent**, and `ARCHITECTURE.md` §11 excludes them:

> **T4 (migration)** — "Procedures that invoke no agent — vault reads, corpus scans, snapshot and publish composers, measurement runs of up to an hour — run in the agent container, because it owns the vault working copy. They share the directive's contract, invocation, failure, and side-effect phases, minus the agent run."

> **`ARCHITECTURE.md` §11, deliberately absent** — "Procedures that invoke no agent — AgentForge runs agents; a consumer's plain work belongs in the consumer."

This is a live conflict between a consumer contract and an accepted decision, so it was **left out of the baseline and is raised** rather than resolved here. It is not a small one: T4's stated reason is *co-location* — the work needs the container's working copy — not convenience, and that reason is not answered by "put it in the consumer". Three shapes are available and the choice is the operator's with TrendBot:

1. **Hold the line.** TrendBot's mechanical work moves to its own container with its own working-copy sync. The cost lands entirely on TrendBot, and duplicates the sync machinery.
2. **Admit a second procedure kind** with the same contract, invocation, failure and phase machinery, minus the run. Cheap to build — the baseline's shapes already separate the run from the phases — but it makes "AgentForge runs agents" false, and §11 would need a superseding decision.
3. **Treat it as a procedure whose run is trivial.** Dishonest, and it would burn a model call per vault read.

Belongs in `DESIGN_OPTIONS.md` §L, where the consumers pull apart.
