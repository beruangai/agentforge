# oRPC as the procedure kernel — spike findings

**Measured 2026-09-22** against **`@orpc/{contract,server,client}@2.0.0-beta.38`** — the `beta` tag, published 2026-09-21 — on Bun 1.4.0 with Zod 4. Source: `spikes/procedure-framework/`, carried at A0 into `packages/agentforge/integ/local/procedure-framework/`. No AWS, no model spend.

## Why this was spiked at all

Not "is oRPC nice", but one crux that decides it, and which the operator identified:

**Every AgentForge procedure is really several.** Invocation is asynchronous and `returnImmediately` is always set, so a start returns a *handle*, never an outcome — which means **the start's output schema is identical for every procedure** — and the caller then polls, and may cancel. End-to-end type safety needs those calls typed per declaration **whatever framework is used**. The current design solves this implicitly and untyped.

So: can one contract be split by a utility into two typed procedures, with the types flowing end to end through a transport that is not HTTP? If the type flow breaks at the split, nothing else about oRPC matters.

## What was proved

| Question | Result |
|---|---|
| One contract split into typed procedures | **yes** — a small utility over `oc.input().output()` |
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

## The split, corrected — 2026-09-23

The first spike derived a `submit`/`result` **pair**. The operator rejected it on a point the spike had not tested: a caller polling a running task needs its **non-terminal state**, and a procedure that answers only when settled gives a heartbeating activity nothing to read. Cancellation had nowhere to live either.

**The wire settles the shape, and it is three.** A2A 1.0 has exactly three task RPCs, and `GetTaskRequest` is `{ id, historyLength? }` returning the whole `Task` — status *and* artifacts, with **no artifact filter**. So a fourth `outcome` procedure would be a second name over one wire call returning identical bytes.

| Derived | Where | Typed by the procedure? |
|---|---|---|
| `SendMessage` | per procedure | input yes; output is the shared task handle |
| `GetTask` | per procedure | yes — a discriminated union on the task state |
| `CancelTask` | **root, once** | **no** — a task id in, a state out, identically for every task |

`CancelTask` is a separate invocation carrying the id `SendMessage` returned; nothing is held open between them.

Proved in `o6-task-centric-split.ts`, `tsc --strict` clean with its directives verified live:

- **Narrowing flows through the link.** `task.output` is a compile error before the `state === 'SUCCEEDED'` check and typed inside it; a failure's `cause` is absent from the success branch.
- **Each procedure's `status` carries its own output type.** Reading `reviewStrategy`'s `verdict` off `summariseCorpus`'s status does not compile — the union is built from that contract's output, not a shared one.
- **`cancel` rejects a procedure input**, because it is not shaped by the contract.

**On the naming — A2A's verbs, verbatim.** A first pass named these `create`/`status`/`cancel`. The operator rejected it: the wire is A2A, so a translation layer over terms that already exist buys ambiguity and nothing else, and `status` was actively misleading once it carried the outcome. The rule is now in `CLAUDE.md` — borrow verbatim, never shorten, clarity over brevity. **Leaf procedures are `PascalCase`, namespaces `camelCase`**, so `reviewStrategy.SendMessage` and `CancelTask` at the root.

## Per-call context is enforced per call — 2026-09-23

Two values ride beside a call's input and neither is any procedure's to declare: `runtimeSessionId`, which becomes the AgentCore session header, and `idempotencyKey`. They are **not required on the same calls** — only a start is idempotent, and demanding a key on a poll would make a caller invent a value that means nothing.

`RouterContractClient<TContract, TClientContext>` distributes **one** context type over every leaf, so this does not come for free. It works because AgentForge writes the client type rather than deriving it wholesale: a mapped type applies `Starting = { runtimeSessionId, idempotencyKey }` to `SendMessage` and `Routed = { runtimeSessionId }` to `GetTask` and `CancelTask`. The link itself takes the looser `Routed & { idempotencyKey?: string }`, which is sound — the **client's** annotation is the gate, which is exactly the hazard recorded above working in our favour, and the reason a consumer must never write that type.

Proved in `o7-a2a-verbs-and-per-call-context.ts`, `tsc --strict` clean with its directives verified live: a `SendMessage` with no key does not compile, nor one with no session to route to; a `GetTask` must still be routed and is **not** asked for a key; `CancelTask` rejects a procedure's input; and each namespace's `GetTask` still carries its own output type.


## A router assembled on a middlewared builder runs its middleware twice — 2026-09-23

Found while carrying the spikes into `packages/agentforge/integ/local/procedure-framework/`, on **beta.39 and re-checked on beta.38** — so not drift, just something the spikes' own pattern hid. `implementer.use(middleware).router({ … })` re-applies the middleware to procedures that already carry it, and oRPC does not deduplicate: build procedures on `os = base.use(house)` and then assemble with `os.router(…)`, and **`house` runs twice per call**. Assembling on the unmiddlewared implementer runs it once. The spikes could not see it because their middleware overwrote a record rather than counting.

It matters for any middleware with a side effect — a lease writer, a telemetry span, an audit record. **The router is assembled on the base implementer**, and `custom-link-and-typed-context.test.ts` asserts both counts, so a future oRPC that deduplicates is reported rather than silently changing behaviour.

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
DynamoDB write already in the design (§REQ103) — and a mutex adds nothing to it. The
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
