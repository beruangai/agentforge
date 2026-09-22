# oRPC as the procedure kernel — spike findings

**Measured 2026-09-22** against **`@orpc/{contract,server,client}@2.0.0-beta.38`** — the `beta` tag, published 2026-09-21 — on Bun 1.4.0 with Zod 4. Source: `spikes/procedure-framework/`. No AWS, no model spend.

## Why this was spiked at all

Not "is oRPC nice", but one crux that decides it, and which the operator identified:

**Every AgentForge procedure is really two.** Invocation is asynchronous and `returnImmediately` is always set, so a submit call returns a *handle*, never an outcome — which means **the submit-side output schema is identical for every procedure**, and a second, separately typed call fetches the result. End-to-end type safety needs a start/fetch pair per declaration **whatever framework is used**. The current design solves this implicitly and untyped.

So: can one agentic contract be split by a utility into two typed procedures, with the types flowing end to end through a transport that is not HTTP? If the type flow breaks at the split, nothing else about oRPC matters.

## What was proved

| Question | Result |
|---|---|
| One contract split into typed `submit` + `result` | **yes** — a 6-line utility over `oc.input().output()` |
| Types flow through the split | **yes** — 5 `@ts-expect-error` probes, all genuine |
| A custom link over a non-HTTP transport | **yes** — envelope is exactly `{ path, input }` |
| The client is typed **through** that link | **yes** — 3 further probes, all genuine |
| Middleware contributing **typed** context | **yes** — `context.lease.holder` read in a later middleware with **no cast** |
| Raw errors survive in-process | **yes**, with stack |
| Errors survive a **serialising** transport | **yes** — message, structured `data` *and* the original stack |

Every type probe is backed by a **negative control**: a directive placed on a valid line, confirmed to be reported as unused. Without that, a passing probe proves nothing — and the first run of the control was itself broken (it pointed at the wrong config), which is why it is stated here rather than assumed.

The split utility, entire:

```ts
function split<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(c: { input: I; output: O }) {
  return { submit: oc.input(c.input).output(taskHandle), result: oc.input(taskQuery).output(c.output) };
}
```

**Error fidelity is the link's choice, not the framework's.** Across a serialising transport the message, the structured `data` and the original stack all arrived — because the link carries them. oRPC does not marshal errors behind the caller's back, so the `Rethrow` plugin is an HTTP-adapter concern and not needed when the link is ours. This was the stated pain point with tRPC.

## What was not tested

Recorded as gaps, not as risks discounted:

- **Streaming and cancellation** over a custom link. The proposal flags both; neither was exercised.
- **The link's own typing.** The client type is proved; the link object itself was passed with a cast, because a full `ClientLink` was not implemented.
- **The `Locking` helper** against the idempotency requirement, and the rest of the plugin surface.
- **Worker threads.** oRPC ships a worker-threads adapter, but threads share a heap and do not give what [ADR 0004](../../adr/0004-a-process-per-task.md) buys — a process group whose `SIGKILL` takes a grandchild, measured in `task-process-and-cost.md`. oRPC does not require it: `call()` in-process works, and AgentForge keeps spawning its own process. The adapter is not a substitute.

## Standing considerations

- **v2 is beta** (`2.0.0-beta.38`, 38 betas). The operator's direction is to target v2 rather than adopt v1 on the edge of a major migration.
- **Maturity**: MIT, org `middleapi`, 5,636 stars, **67 contributors**, ~946k weekly downloads on v1, pushed daily. An earlier note in this repository said "single maintainer" — that came from npm's `maintainers` field, which is publish rights rather than project maintainership, and it was wrong.
- **`@orpc/contract` is 90 KB** and depends on `@standard-schema/spec`, so **Zod 4 works natively**. It pulls `@orpc/client` (138 KB), which is what a caller needs in order to call — not incidental weight.

## What this does to the existing decisions

[ADR 0013](../../adr/0013-a-procedure-is-an-object-literal.md) compared three **hand-built** authoring styles. It never compared building against adopting, and the object literal was chosen partly because the alternative was machinery to build and maintain. That premise no longer holds, so the decision is open again on its own terms rather than being reversed.

[ADR 0003](../../adr/0003-procedures-are-type-safe-end-to-end.md) says an asynchronous call "leaves an RPC framework's request-response typing with nothing to type". That reasoning does not survive the two-procedure realisation: there are two things to type, and contract-first types both.
