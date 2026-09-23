# AgentCore Runtime — what it actually does

**Measured on 2026-09-22** against a real runtime in `us-west-2`, and **re-run on 2026-09-24 in `us-east-2`** by the integration tests, which all pass there — every finding below held except the pre-warmed pool, as noted. Account 913756569129: an ARM64 container, `PUBLIC` network mode, `serverProtocol: A2A`, built on `@a2a-js/sdk@1.2.0`. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §B, §C's platform half, and the AgentCore half of §I.

This note is **observed behaviour**. [`agentcore-runtime.md`](agentcore-runtime.md) is what the documentation *says*; where the two differ, this note names the difference. Source: `spikes/agentcore/`, carried at A0 into `packages/agentforge/integ/aws/agentcore/`, which re-checks it against the platform. The container mints a container id at process start and returns it on every task, so "the same container" is observed rather than inferred.

No model was called. A "task" is a timer, so every number here is platform cost.

---

## Correction to an earlier claim

An earlier commit (`70ff01b`, 2026-09-22) recorded that **`InvokeAgentRuntime` strips `content-type`**. That is **wrong**, and the correction matters because it changes the fix.

`InvokeAgentRuntime` **forwards the caller's `content-type` unchanged, and sends none when the caller sent none.** The earlier observation came only from the AWS CLI, whose `--payload file://…` sends no content type at all. `@aws-sdk/client-bedrock-agentcore` defaults to `application/octet-stream`, which `@a2a-js/sdk`'s `jsonRpcHandler` rejects with `-32005 CONTENT_TYPE_NOT_SUPPORTED` — surfacing to the caller as **HTTP 424 with `-32055 "Runtime client error - Please check your CloudWatch logs"`**, which names neither the header nor the cause.

**The fix is on the caller**: set `contentType: 'application/json'` on `InvokeAgentRuntimeCommand`. A permissive body parser in the container (`express.json({ type: () => true })`) makes the body *parse*, but does not stop `jsonRpcHandler` rejecting the content type, so it is not sufficient on its own.

---

## The headers that survive — and the allowlist that decides

**Corrected 2026-09-22, after the operator pointed at the [request header allowlist](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html).** An earlier version of this note said `A2A-Version` is *never* forwarded and that *no* custom header survives. Both were the **default** behaviour reported as the platform's, and both are wrong as stated.

**By default**, exactly these arrive and nothing else:

```
x-amzn-requestid, baggage, content-length, host,
x-amzn-bedrock-agentcore-runtime-session-id, x-amzn-trace-id
  (+ content-type and accept, which are InvokeAgentRuntime's own parameters)
```

**But AgentCore forwards any header placed on a per-runtime allowlist**, configured as `requestHeaderConfiguration: { requestHeaderAllowlist: [...] }` on `CreateAgentRuntime` and `UpdateAgentRuntime` — up to 20 headers, 4 KB each, excluding a published restricted table and anything prefixed `x-amz-` / `x-amzn-` (except `X-Amzn-Bedrock-AgentCore-Runtime-Custom-`).

Measured with `A2A-Version` and `X-Agentforge-Probe` allowlisted (`spikes/agentcore/i2-header-allowlist.ts`). The allowlist itself is documented, so it is not re-tested: the one header AgentForge relies on, `A2A-Version`, is exercised by `a2a-1-0-only-through-agentcore.test.ts`. The header test that carried this table was removed on 2026-09-24; git history keeps it.

| Sent | Reached the container | SDK negotiated |
|---|---|---|
| nothing | — | **0.3** |
| `A2A-Version: 0.3` | **yes** | 0.3 |
| `A2A-Version: 1.0` | **yes** | **1.0** |
| `X-Agentforge-Probe` (allowlisted) | **yes** | 0.3 |
| `X-Not-Allowlisted` | **no — dropped** | 0.3 |

So: **the allowlist is a strict filter, and `A2A-Version` passes it.** `A2A-Version` is a valid header name, is absent from the restricted table, and is not `x-amzn-`-prefixed, so nothing blocks it.

**The design consequence is the opposite of what this note first recorded.** AgentForge is **not** pinned to protocol 0.3. It can allowlist `A2A-Version` and negotiate 1.0. What that buys and what it costs is a decision, not a measurement — see the open question below.

### 1.0 only is achievable, and it fails better than 1.0-with-0.3

**Asked by the operator on 2026-09-22: can AgentForge run 1.0 and never carry 0.3?** A2A is AgentForge's transport, never exposed to a consumer or to an agent, so there is no caller to stay compatible with. Measured with two servers side by side (`spikes/agentcore/i3-strict-10.ts`, now `packages/agentforge/integ/local/a2a-version-negotiation/`) — one declaring a single 1.0 interface with `legacyCompat` off, one declaring both:

| Request | Strict (1.0 card, `legacyCompat` off) | Permissive |
|---|---|---|
| no `A2A-Version` | **`-32009` version '0.3' is not supported** | OK, negotiates 0.3 |
| `A2A-Version: 0.3` | **`-32009`** | OK, negotiates 0.3 |
| `A2A-Version: 1.0` + `message/send` | `-32601 Invalid method` | OK |
| **`A2A-Version: 1.0` + `SendMessage`** | **OK, negotiates 1.0** | OK, negotiates 1.0 |

**Yes, and it is the better failure mode.** Earlier in this session I argued for keeping `legacyCompat` enabled as a safety net against a missing allowlist entry. That was backwards: with it **on**, a missing or misspelt `A2A-Version` entry downgrades every call to 0.3 and the system *appears to work* on the wrong protocol. With it **off**, the same mistake fails on the first invocation with `-32009`. Zero silent failures wants it off.

What 1.0-only requires, all of it configuration:

1. the card declares **one** interface, `protocolVersion: '1.0'`;
2. `legacyCompat: { enabled: false }` on both handlers;
3. the runtime allowlists **`A2A-Version`**;
4. **nothing on the client.** The SDK's own `ClientFactory` over `JsonRpcTransportFactory`, built from the 1.0-only card, sends `A2A-Version: 1.0` and the `SendMessage` method **by itself** — measured end to end, server negotiated 1.0.

**Confirmed end to end on the real platform**, not inferred from two halves: a strict 1.0 runtime (`A2A_STRICT_10=1`, `requestHeaderAllowlist: ["A2A-Version"]`) answered `A2A-Version: 1.0` + `SendMessage` with `negotiated=1.0`, and refused the same call without the header.

### The 1.0 wire shape, captured from the SDK's own client

Neither shape used in the earlier spikes. Taken off the wire by intercepting `fetchImpl`:

| | 0.3 | **1.0** |
|---|---|---|
| method | `message/send` | **`SendMessage`** |
| `role` | `"user"` | **`"ROLE_USER"`** |
| a data part | `{ kind: 'data', data: {…} }` | **`{ data: {…} }`** — no `kind`, no `content` |

`{ content: { $case: 'data', value } }` is the SDK's **internal** type and is not a wire shape in either version — writing it by hand is what produced the "silently stripped" part. A client must be handed the SDK's typed object and allowed to serialise it; a server must read `part.data`.

Under a 1.0 negotiation the server accepted a 0.3-shaped part too, so **the version gate is the header, not the part encoding**.

### The one cost of strict 1.0: the rejection is opaque

A 0.3 caller against a strict runtime does *not* receive the useful `-32009`. AgentCore wraps any non-2xx container response, so the caller sees **HTTP 424 `-32055 "Runtime client error - Please check your CloudWatch logs"`** — the same opaque error as a crash or a bad content type.

The failure is loud but **undiagnosable from the outside**. That is not a reason to keep 0.3; it is a reason for the client to **assert the negotiated version it got back** rather than infer success from a 200, and for the gateway to surface the request id.

Two things that change with it, and both matter:

- **The method names change.** 1.0 uses the protobuf RPC names — `SendMessage`, `GetTask`, `CancelTask` — not `message/send`, `tasks/get`, `tasks/cancel`. Every spike written before this used the 0.3 names.
- **The part-reader guard becomes *more* important, not less.** The silent strip below is triggered by `SendMessage` — which is precisely the 1.0 method name. Choosing 1.0 does not remove that failure; it puts AgentForge permanently on the method name that exhibits it.

### The part shape is a wire question, not a version question

A related correction. The earlier note claimed "a part whose encoding does not match the negotiated protocol version is stripped of its content in silence". The **failure is real**; the **trigger was wrong**. Isolated by varying one thing at a time:

| RPC method | Part shape | Result |
|---|---|---|
| `message/send` | `{ kind: 'data', data }` | **works**, under 0.3 *and* 1.0 |
| `message/send` | `{ content: { $case: 'data', value } }` | rejected, `-32602` |
| **`SendMessage`** | **`{ content: { $case: 'data', value } }`** | **accepted, content silently gone** |
| `SendMessage` | `{ kind: 'data', data }` | works |

**The silent strip is triggered by the 1.0 RPC method name `SendMessage`**, not by the negotiated version — it happens with `A2A-Version: 1.0` set and without it alike. Under `SendMessage` the parser accepts the message and drops a `content` oneof it does not recognise, with no error at any layer, and an executor reading the envelope trustingly falls through to its defaults.

`{ kind: 'data', data }` is the wire shape in **both** protocol versions; `{ content: { $case } }` is the SDK's *internal* protobuf representation and was never a wire shape at all. So the practical rule is narrower than first written but no less sharp: **a part reader must throw on a part it cannot decode**, because one combination of method name and part shape delivers an empty envelope and calls it success.

## `GetAgentCard` — served verbatim, except the URLs

`GetAgentCard` returns **the container's own card**, not a platform-synthesised one: `name`, `skills` and both declared `supportedInterfaces` came back unchanged. The platform **rewrites `url` and every `supportedInterfaces[].url`** to

```
https://bedrock-agentcore.us-west-2.amazonaws.com/runtimes/<url-encoded ARN>/invocations
```

So the container need not know its own public URL — and must not be relied on to declare it.

---

## §B — one session, one container, and a busy container still answers

### A runtime session id maps 1:1 to a container, and stays put

Six brand-new session ids fired in parallel landed on **six distinct containers**. Fired again three seconds later, **6/6 returned the same container**. Separately, one session's eight calls spanning ~35 seconds — including an idle gap and a task boundary — all hit one container.

### Pre-warmed containers: seen once, not reproduced, and not relied on

On 2026-09-22 in `us-west-2`, at a session's **first** call the container had already been up for **28–212 seconds**, read as a pool a session claims rather than starts.

**Not reproduced on 2026-09-24 in `us-east-2`**, twice. Ten containers announced themselves ~6 s after `CreateAgentRuntime` and **none** served a session: the warm-up call and all six sessions each landed on a container started for it — up 0.8–1.6 s at its first call, which took 3.6–5.5 s. The second call to each session reached the same container in ~0.4 s.

Nothing in AgentForge depends on a warm pool, so this is recorded rather than tested. What AgentForge does depend on — one microVM per session, and a session id routing to it — is AgentCore's documented guarantee ([`agentcore-runtime.md`](agentcore-runtime.md) §Sessions), and is not re-tested either. `container-per-session.test.ts` was removed on 2026-09-24 for both reasons; git history keeps it.

### What a session costs

| | |
|---|---|
| A session's **first** call | **≈ 1.2 s** (`us-west-2`, 2026-09-22); **3.6–5.5 s** (`us-east-2`, 2026-09-24, a container started per session) |
| Every call after that | **≈ 355 ms**; ≈ 420 ms in `us-east-2` |
| So: session establishment | **≈ 850 ms** to **several seconds** — a caller tolerates a multi-second first call |

> An earlier run of this spike showed ~2.66 s for a first call. That number was **client-side**: credential resolution, TLS and the SDK's lazy loading all land on whichever call happens to be first. The spike now makes a warm-up call and discards it. Recorded because ~2.6 s would have been quoted as a platform cost and it is not one.

### A busy container receives everything — §B's actual question

With a **25-second task live** and `/ping` reporting `HealthyBusy`, three further calls were sent to the same session:

| Call, while busy | Delivered | Latency |
|---|---|---|
| a second `message/send` | yes | 361 ms |
| `tasks/get` | yes | 887 ms |
| `tasks/cancel` | yes | 398 ms |

**3/3, at latencies indistinguishable from an idle session** (355 ms). The second task ran **concurrently in the same container** — the container reported `liveTasks: 2`.

**`ARCHITECTURE.md` §4's inference is confirmed: `/ping` is a lifecycle signal, not admission control.** The await path rests on this, and it now rests on a measurement.

The gateway's idempotency index also held over the real platform: the same key sent twice returned **the same task id**.

### The provisioning window returns no 409 — it blocks

`InvokeAgentRuntime` was called repeatedly from the instant `CreateAgentRuntime` returned, on one session id:

| | |
|---|---|
| `CreateAgentRuntime` returned | 2.9 s, `status: CREATING` |
| first invoke issued | +2.9 s, while still `CREATING` |
| that invoke **returned OK** | +8.7 s — **one call blocked for ~5.8 s** |
| control plane reported `READY` | +10.0 s |

**No `RetryableConflictException` and no HTTP 409 was ever seen.** The documentation describes a 409 while a session is provisioned or torn down; what this observed is a call that simply waits. **One observation** — enough to say a caller must tolerate a multi-second first call, not enough to say 409 never happens.

The session held **one container across the `CREATING` → `READY` transition**.

### Deleting is far slower than creating

`CreateAgentRuntime` reaches `READY` in **~10 seconds**. `DeleteAgentRuntime` returns immediately but the runtime sat in `DELETING` for **about five minutes**, and the workload identity AgentCore mints alongside it stays listed until the runtime is gone — `DeleteWorkloadIdentity` refuses it with *"WorkloadIdentity is linked to a service and cannot be deleted by the caller"*.

Two consequences for the deploy path: **a teardown cannot be treated as synchronous**, and a CI job that creates a runtime, tests it and deletes it must either wait or tolerate the leftover. Re-creating a runtime with the same name while the old one is still `DELETING` was not tested.

---

## §C — `StopRuntimeSession`

| | |
|---|---|
| `StopRuntimeSession` returns | HTTP 200, **≈ 375–405 ms** |
| the container receives **SIGTERM** | **≈ 400 ms** after the call, `liveTasks: 1` — mid-task |
| the next invoke on the same session id | succeeds, on a **fresh container**, with an **empty task store** |

So the platform *is* cooperative at the edge — a real SIGTERM, delivered while work is in flight — but **the session's in-flight task is unreachable from the caller the moment the stop returns**: `tasks/get` against the original task id answers `Task not found` from the new container, for as long as it was polled (25 s).

**A stop is therefore not a cancel.** The consumer's side-effect recovery cannot be driven through the session after a stop, because the session no longer points at the process doing the work. Anything that must survive a stop has to be outside the container before the stop lands.

### The grace period is fixed at about a minute, and being busy does not extend it

The container deliberately does **not** exit on SIGTERM; it logs a heartbeat every 500 ms, so the moment it is killed is the last beat.

The first run could not distinguish a fixed window from "killed once it stops reporting busy" — a 60-second task was stopped and its container died 56 s later, which is both. So two sessions were stopped **at the same instant**, one holding a 4-second task and one a 240-second task:

| Task in flight at the stop | Survived after SIGTERM | `liveTasks` at the last beat |
|---|---|---|
| 4 s — long finished | **62.6 s** | 0 |
| 240 s — still running | **61.0 s** | **1** |
| 60 s (first run) | 56.0 s | 1 |

**Both died at essentially the same offset, ~60 seconds, regardless of whether work was still in flight.** The window is fixed:

- **Finishing early does not release the container** — the idle one lived 58 seconds past the end of its work.
- **Being busy does not extend it.** The 240-second task was live, so `/ping` was answering `HealthyBusy`, and the container was killed anyway. `HealthyBusy` keeps an *idle* session alive past the 15-minute reap; it does **not** hold off a kill that a stop has already started.

Across three observations the window was 56.0 s, 61.0 s and 62.6 s — consistent with a nominal 60 seconds plus a few seconds of jitter, not tied to the workload.

**The number that matters to a consumer: a stopped run has about a minute, and then it is gone.** Side-effect recovery that cannot complete inside ~60 seconds must not be attempted in the container at all.

### And the minute is usable

Knowing a container has 60 seconds is only half an answer — what matters is whether it can still reach the network in them. It can. The container writes an outcome row to DynamoDB **from inside its `SIGTERM` handler**, and with a 120-second task still running:

| | |
|---|---|
| outcome row visible | **3.5 s after `StopRuntimeSession` returned** |
| written, measured from `SIGTERM` | **0 ms** — the handler's first action |
| live tasks at that moment | 1 |

So networking, credentials and the DynamoDB client all survive `SIGTERM`; nothing is torn down ahead of the process. **A stopped run can record its own outcome rather than being inferred `LOST` by a later reader** — which is what makes `ARCHITECTURE.md`'s "a side effect's recovery is the consumer's" implementable on this platform at all, inside a budget of about a minute.

---

## §A — the lease, written and renewed from inside a microVM

`agentforge-spike-lease`, on-demand DynamoDB in the same region, a 236-byte item, six renewals at a 2-second interval, written by the container while a task ran.

| | |
|---|---|
| **write latency, inside the microVM** | **median 7 ms** (range 6–67 ms; the 67 ms is the SDK's first call) |
| **write → visible to an eventually-consistent read** | **median 11 ms** (range 9–72 ms) |
| read-backs needed to see a renewal | **1, every time — 6/6** |
| lease item, as returned | 236 bytes, 1 RCU |
| renewals implied by a 1-hour run at 2 s | 1,800 writes |

**An eventually-consistent read never once failed to see a just-written lease** — but DynamoDB documents no such bound, so nothing is built on it: the lease is read with `ConsistentRead`, whose read-after-write DynamoDB does guarantee, at 1 RCU instead of half of one for a 236-byte item. These numbers settle §A's interval once and are not re-tested; `lease-visibility.test.ts` was removed on 2026-09-24, and git history keeps it.

**A renewal costs the task about 7 ms.** A 2-second interval is affordable: 1,800 writes an hour of a 236-byte item is roughly a fifth of a cent per hour on-demand, and the interval could go well below 2 seconds before the write cost became visible against the work it is guarding.

### Why the first attempt at this number was thrown away

The first version polled DynamoDB **from a laptop** and reported "visibility ≈ 322 ms". That figure conflated four things — the write, DynamoDB's propagation, a **241 ms read RTT from outside AWS**, and a **333 ms apparent clock offset** between two unsynchronised clocks, itself of the same order as the invoke round trip and therefore mostly asymmetric latency rather than skew. None of it was a platform number.

The measurement above uses **one clock and one network**: the container writes and reads back itself. The laptop figure is kept only as the contrast it is — **an external reader's own RTT dominates the lease mechanics by more than twenty times**, so where the reader runs matters far more than anything DynamoDB does.
