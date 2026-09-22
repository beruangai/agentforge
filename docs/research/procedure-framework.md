# oRPC as the procedure kernel — spike findings

**Measured 2026-09-22** against **`@orpc/{contract,server,client}@2.0.0-beta.38`** — the `beta` tag, published 2026-09-21 — on Bun 1.4.0 with Zod 4. Source: `spikes/procedure-framework/`. No AWS, no model spend.

## Why this was spiked at all

Not "is oRPC nice", but one crux that decides it, and which the operator identified:

**Every AgentForge procedure is really two.** Invocation is asynchronous and `returnImmediately` is always set, so a submit call returns a *handle*, never an outcome — which means **the submit-side output schema is identical for every procedure**, and a second, separately typed call fetches the result. End-to-end type safety needs a start/fetch pair per declaration **whatever framework is used**. The current design solves this implicitly and untyped.

So: can one contract be split by a utility into two typed procedures, with the types flowing end to end through a transport that is not HTTP? If the type flow breaks at the split, nothing else about oRPC matters.

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

## The gaps, closed — 2026-09-23

The four gaps left open above were spiked. `o4-streaming.ts` and
`o5-cancellation-and-typed-link.ts`, both `tsc --strict` clean with their
`@ts-expect-error` directives verified live by flipping one to a valid line and
confirming TS2578.

| Question | Result |
|---|---|
| A stream survives a non-HTTP link | **yes** — 3 events, 3 byte frames, 156 bytes |
| It is streamed, not buffered | **yes** — `encode:BEFORE receive:BEFORE encode:RUN receive:RUN …` |
| A `ClientLink` needs no cast | **yes** — `ClientLink<T>` is one method; o2's `as any` was avoidable |
| Client context is compiler-enforced per call | **yes** — a submit with no idempotency key does not compile |
| A signal reaches middleware and handler | **yes**, and it is the same object in both |
| A running procedure can be cancelled | **yes** — a 5000 ms run returned in 64 ms, `finished: false` |

**The wire encoding is AgentForge's to write.** `eventIteratorToStream` yields
the **event objects**, not encoded bytes — its name suggests otherwise and the
first attempt at this spike was wrong because of it. oRPC's SSE encoding lives
in its HTTP handler, which AgentForge does not use. So a streaming link
serialises each event itself; `RPCSerializer` plus one JSON line per event is
enough and keeps `Date`/`BigInt` fidelity:

```ts
`${JSON.stringify(serializer.serialize(event))}\n`   // {"json":{"phase":"BEFORE",…}}
```

The decoder must buffer partial lines and **throw on a stream that ends
mid-frame** rather than dropping the tail.

**Client context is the right home for the idempotency key.** `ClientLink<T>`
types what a caller supplies *per call*, separately from the input, so the key
is required by the compiler without any procedure declaring it — which is what
`ARCHITECTURE.md` wants and what the object literal could not express.

**One hazard, stated rather than probed.** A link may declare a *looser*
context than the client requires; that is ordinary contravariance and sound —
the link just ignores what it is handed. The requirement is enforced by the
**client's own type annotation**, so that annotation is AgentForge's to vend
and not a consumer's to write. The opposite direction is caught: a link
demanding more than the client promises is rejected at `createORPCClient`.

**Cancellation is out of band, and the link must say so.** oRPC threads an
`AbortSignal` from the call to middleware and handler, and a handler that races
its work against it returns promptly. But a caller's signal cannot travel with
an `InvokeAgentRuntime` call — AgentForge cancels by a separate `CancelTask`
invocation ([ADR 0002](../../adr/0002-a2a-is-the-boundary-contract.md)). So the
link **must** map a caller abort onto that out-of-band cancel; accepting a
signal and dropping it would be a silent failure.

## `Locking` does not answer idempotency

Read from [the Lock helper's documentation](https://orpc.dev/docs/helpers/lock)
on 2026-09-23. `@orpc/experimental-lock` is **a mutex, not a dedupe store**:

```ts
lock(key, callback, { ttl?, timeout?, signal? }): Promise<T>
```

It holds a key while a callback runs and releases it afterwards. It does not
store the result, so a repeat does not get the first answer back — the docs say
so explicitly and leave result-checking to the caller. Its adapters are memory,
Redis, Upstash, Bun Redis and Durable Objects; the memory one is per-container
and therefore blind to the rest of the fleet, and AgentForge has no Redis.

AgentForge's requirement is different in kind: an idempotency key must return
**the same task** on a repeat, across containers, after the first container has
died. That is a durable conditional insert keyed on the idempotency key — the
DynamoDB write already in the design (D3) — and a mutex adds nothing to it. The
package is also `experimental-`. **Not adopted.**

## What was still not tested

- **The rest of the plugin surface.** `RequestLimitHandlerPlugin`,
  `TimeoutHandlerPlugin` and the CORS/compression plugins are all handler-level
  and HTTP-shaped, so they do not apply to a custom link. Unexamined, not
  discounted.
- **Worker threads.** oRPC ships a worker-threads adapter, but threads share a
  heap and do not give what [ADR 0004](../../adr/0004-a-process-per-task.md)
  buys — a process group whose `SIGKILL` takes a grandchild, measured in
  `task-process-and-cost.md`. oRPC does not require it: `call()` in-process
  works, and AgentForge keeps spawning its own process. The adapter is not a
  substitute.

## Standing considerations

- **v2 is beta** (`2.0.0-beta.38`, 38 betas). The operator's direction is to target v2 rather than adopt v1 on the edge of a major migration.
- **Maturity**: MIT, org `middleapi`, 5,636 stars, **67 contributors**, ~946k weekly downloads on v1, pushed daily. An earlier note in this repository said "single maintainer" — that came from npm's `maintainers` field, which is publish rights rather than project maintainership, and it was wrong.
- **`@orpc/contract` is 90 KB** and depends on `@standard-schema/spec`, so **Zod 4 works natively**. It pulls `@orpc/client` (138 KB), which is what a caller needs in order to call — not incidental weight.

## What this does to the existing decisions

[ADR 0013](../../adr/0013-a-procedure-is-an-orpc-contract.md) compared three **hand-built** authoring styles. It never compared building against adopting, and the object literal was chosen partly because the alternative was machinery to build and maintain. That premise did not hold, and the ADR was rewritten in place on 2026-09-22.

[ADR 0003](../../adr/0003-procedures-are-type-safe-end-to-end.md) says an asynchronous call "leaves an RPC framework's request-response typing with nothing to type". That reasoning does not survive the two-procedure realisation: there are two things to type, and contract-first types both. The ADR was rewritten in place on 2026-09-22; its rejected "RPC framework" option is now the chosen one.
