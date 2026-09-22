# AgentCore Runtime — what it actually does

**Measured on 2026-09-22** against a real runtime in `us-west-2`, account 913756569129: an ARM64 container, `PUBLIC` network mode, `serverProtocol: A2A`, built on `@a2a-js/sdk@1.2.0`. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §B, §C's platform half, and the AgentCore half of §I.

This note is **observed behaviour**. [`agentcore-runtime.md`](agentcore-runtime.md) is what the documentation *says*; where the two differ, this note names the difference. Source: `spikes/agentcore/`. The container mints a container id at process start and returns it on every task, so "the same container" is observed rather than inferred.

No model was called. A "task" is a timer, so every number here is platform cost.

---

## Correction to an earlier claim

An earlier commit (`70ff01b`, 2026-09-22) recorded that **`InvokeAgentRuntime` strips `content-type`**. That is **wrong**, and the correction matters because it changes the fix.

`InvokeAgentRuntime` **forwards the caller's `content-type` unchanged, and sends none when the caller sent none.** The earlier observation came only from the AWS CLI, whose `--payload file://…` sends no content type at all. `@aws-sdk/client-bedrock-agentcore` defaults to `application/octet-stream`, which `@a2a-js/sdk`'s `jsonRpcHandler` rejects with `-32005 CONTENT_TYPE_NOT_SUPPORTED` — surfacing to the caller as **HTTP 424 with `-32055 "Runtime client error - Please check your CloudWatch logs"`**, which names neither the header nor the cause.

**The fix is on the caller**: set `contentType: 'application/json'` on `InvokeAgentRuntimeCommand`. A permissive body parser in the container (`express.json({ type: () => true })`) makes the body *parse*, but does not stop `jsonRpcHandler` rejecting the content type, so it is not sufficient on its own.

---

## The headers that survive

Every request observed carried exactly these, and nothing else:

```
x-amzn-requestid, baggage, content-length, host,
x-amzn-bedrock-agentcore-runtime-session-id, x-amzn-trace-id
  (+ content-type and accept, only when the caller set them)
```

- **The session header passes through verbatim.**
- **No custom header survives.** Nothing can ride out-of-band alongside a request.
- **`A2A-Version` is never forwarded.** The negotiated version, read off the SDK's own `ServerCallContext`, is **`0.3` on every request**.

This confirms [ADR 0012](../../adr/0012-the-server-is-assembled-not-inherited.md)'s requirement against the platform rather than against AWS's example: **the card must declare a `0.3` `JSONRPC` interface and `legacyCompat` must be enabled on both handlers**, or every call through AgentCore fails with `VERSION_NOT_SUPPORTED`.

### A version-mismatched part is stripped in silence

A part written in the 1.0 protobuf shape — `{ content: { $case: 'data', value: {…} } }` — sent to a server that negotiated 0.3 arrives at the executor **with `filename` and `mediaType` intact and `content` gone**. No error is raised at any layer; the executor sees a part with no payload and, if it is written trustingly, falls through to its defaults.

This is the §I finding with the sharpest consequence, and it is a **zero-silent-failures violation waiting to happen**: the harness must reject a part it cannot decode rather than treating an empty envelope as an empty request. `spikes/agentcore/server.ts` now throws, and the throw is what the production reader should do.

The 0.3 wire shape — `{ kind: 'data', data: {…} }` with `role: 'user'` and `method: 'message/send'` — is delivered intact.

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

### Containers are pre-warmed, not started per session

At a session's **first** call the container had already been up for **28–212 seconds**. Five of six shared an uptime within 900ms of each other, so the pool is replenished in batches. A session claims a warm container; it does not start one.

This corrects the reading taken on the first night, when eleven `listening` events shortly after `CreateAgentRuntime` were read as a pre-warmed pool *and left untested*. The reading was right; it is now measured.

### What a session costs

| | |
|---|---|
| A session's **first** call | **≈ 1.2 s** |
| Every call after that | **≈ 355 ms** |
| So: session establishment | **≈ 850 ms** |

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

**An eventually-consistent read never once failed to see a just-written lease.** DynamoDB's propagation is not a factor to design around at this item size and rate; a strongly-consistent read buys nothing here and costs double.

**A renewal costs the task about 7 ms.** A 2-second interval is affordable: 1,800 writes an hour of a 236-byte item is roughly a fifth of a cent per hour on-demand, and the interval could go well below 2 seconds before the write cost became visible against the work it is guarding.

### Why the first attempt at this number was thrown away

The first version polled DynamoDB **from a laptop** and reported "visibility ≈ 322 ms". That figure conflated four things — the write, DynamoDB's propagation, a **241 ms read RTT from outside AWS**, and a **333 ms apparent clock offset** between two unsynchronised clocks, itself of the same order as the invoke round trip and therefore mostly asymmetric latency rather than skew. None of it was a platform number.

The measurement above uses **one clock and one network**: the container writes and reads back itself. The laptop figure is kept only as the contrast it is — **an external reader's own RTT dominates the lease mechanics by more than twenty times**, so where the reader runs matters far more than anything DynamoDB does.
