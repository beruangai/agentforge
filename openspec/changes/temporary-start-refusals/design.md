# Design

Guidance, not prescription: adapt to what the code and the SDK actually allow.

## The error on the wire

The A2A SDK (1.2.0) turns a thrown error into the JSON-RPC error itself, and AgentForge can't set every field:

- An error of its own spec'd classes gets A2A's code, and `data: [ErrorInfo]`.
- An error it doesn't know, if it subclasses `A2AError`, gets `INTERNAL_ERROR` (`-32603`) and `data: [error.toErrorInfo()]`. `toErrorInfo()` can be overridden.
- A JSON-RPC-transport error with its own `envelopeCode` keeps that code, but loses `data`.

So the refusal's meaning lives where A2A 1.0 puts an error's machine-readable identity, in `google.rpc.ErrorInfo`, not in the code:

```
{ code: -32603, message: "<why, for a human>",
  data: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo",
           reason: "SERVICE_UNAVAILABLE" | "TOO_MANY_REQUESTS",
           domain: "agentforge",
           metadata: { refusal: "CONTAINER_STOPPING" | "ADMISSION_LIMIT" | "CONTINUITY_KEY_RUNNING",
                       retryAfterSeconds: "600" } }] }
```

- `reason` carries your HTTP semantics, and `refusal` says which. `ErrorInfo.metadata` is a string map, so seconds go as a string. Seconds, as HTTP's `Retry-After` uses, are immune to clock skew.
- A client recognises a refusal by `domain` and `reason`, never by the code. An ordinary internal error has no `agentforge` ErrorInfo.
- The alternative, rewriting the code on the way out of Express, would buy a distinct code at the cost of a response hook. Not worth it.
- The reasons, the refusals and a Zod schema for the ErrorInfo live once in `core/`, used by the server to build it and the client to parse it. The server's error class is a small `A2AError` subclass that overrides `toErrorInfo()`.
- To verify when implementing: the local server answers HTTP 200 with this body, as it does for "Task not found", and AgentCore passes it through intact. Assert the second with a continuity-key refusal added to `integ/aws/agentcore/agentforge-runtime.test.ts`, which runs without a model. That's cheaper than `e2e-agentcore`, and no new test file is needed.

## Where each refusal is decided

The gateway keeps its order: session header, idempotency lookup and attach, then the refusals. A start whose key names a live or completed task still attaches, even while the container is stopping or full, because it asks for nothing new. Each refusal returns before the SDK's `sendMessage`, so no task id is minted, nothing is stored and `bindKey` is never reached.

| Refusal | Check | `retryAfterSeconds` |
|---|---|---|
| `CONTAINER_STOPPING` | `executor.stopping` | 5 |
| `ADMISSION_LIMIT` | `liveCount >= admissionLimit` | 600 |
| `CONTINUITY_KEY_RUNNING` | a live task holds the key | Ceiling of the holder's remaining time budget, at least 1 |

- The executor already knows each live task's budget. It records the start time beside it and exposes `continuityKeyRetryAfterSeconds(key)`, or folds it into `hasLiveContinuityKey`'s answer.
- Draining is 5 s because the platform routes the session's next call to a fresh container within about half a second of a stop (research, `StopRuntimeSession`). Only a start that raced the stop reaches a stopping container.
- 600 s is a constant until a consumer needs another value.

**The race with a stop.** The SDK awaits between the gateway's check and the executor, so a container can begin stopping in between. The executor already catches this: it publishes `SUBMITTED` (so `returnImmediately` can answer) and then, in the same synchronous turn, finds `#stopping` and ends the task `REJECTED` without spawning. That task now needs to become the same in-band refusal:

- The executor records the admission's `startId` as refused, synchronously in that branch. It already keys failed starts by `startId`.
- `sendMessage` resolves only after the ResultManager's awaits, so the record is there by then. The gateway checks it before `bindKey`. If the start was refused, the gateway returns the `CONTAINER_STOPPING` refusal and doesn't bind the key.
- The stored task is an orphan no key names and no caller holds an id for. It expires with the table's TTL.

**The server logs every refusal**, one line with its reason and retry time, so an operator can see a container turning callers away.

## Client

- `transport.ts`'s `resultOf` parses `error.data` against the core schema. When it finds an `agentforge` refusal, it throws `StartRefusedError`, a subclass of `AgentForgeRequestError` carrying `refusal`, `retryAfterSeconds` and `retryAfter` (a `Date`).
- The AgentCore session-creation retry (`-32054`/`-32055`) is untouched, and never sees a refusal.
- The client doesn't retry a refusal itself.

## Temporal activity

`procedureActivity` is one activity: it starts (or attaches) and then polls until the task ends. Only the start can be refused. `GetTask` has no admission, and a poll that fails fails the activity. The retry then sends the start again under the same key, which attaches.

**Inside the activity first.**
- On a refusal, the activity waits `retryAfterSeconds` and starts again with the same idempotency key. That is safe because a refusal binds nothing.
- The wait heartbeats and ends at once on the activity's cancellation.
- Each attempt has a fixed budget of **15 minutes of waiting**, counted from its first refusal. It isn't rolling: the waits add up, and once the next wait would take the total past 15 minutes, the activity stops waiting.
- The budget is a constant until a caller needs another value.

**Then Temporal.** Past the budget, the activity fails as follows:

```
ApplicationFailure.create({ type: refusal, message, nonRetryable: false,
                            nextRetryDelay: retryAfterSeconds * 1000 })
```

- Temporal's next attempt starts with a fresh budget.
- The idempotency key is the workflow run and activity id, so it is the same on every attempt. A refused start bound nothing, so the start is fresh.

**The client doesn't retry.** The retry policy lives in the activity.

**What `procedureActivity`'s doc comment and the README tell a caller:**
- `startToCloseTimeout` must cover the task's time budget plus up to 15 minutes of waiting.
- `maximumAttempts` counts budgets spent, not refusals: at the admission limit, one 600 s wait fits the budget and the next fails the attempt, so an attempt takes about 20 minutes, roughly 3 an hour.
- Each wait between attempts counts toward `scheduleToCloseTimeout`, and a delay that would pass it ends the activity at once, with its own failure (retry state `TIMEOUT`).
- A workflow's own timeouts must leave room for the waits.
- Workflow code can't widen an activity's options once it is scheduled. Only an operator can, with the CLI's experimental `temporal activity update-options`.

Check these Temporal facts against its docs when implementing, and record them in research.

## What stays `TASK_STATE_REJECTED`

These are stored as today:
- an unknown procedure;
- a contract hash mismatch;
- invalid input, including an input record over its 350 KB cap.

A key reused in another runtime session stays a thrown `RequestMalformedError`.

## Tests

- **Unit, gateway:**
  - each of the three refusals returns the in-band error with no `save` and no `bindKey`;
  - an attach still wins while stopping or full;
  - the raced stop becomes a refusal and leaves the key unbound.
- **Unit, executor:** the continuity retry time.
- **Unit, transport:** a refusal body becomes `StartRefusedError`, and an ordinary `-32603` doesn't.
- **Unit, activity:**
  - a refusal is waited out and started again within the budget, with a heartbeat while it waits;
  - a cancel ends the wait;
  - past the budget, a refusal becomes a retryable failure with `nextRetryDelay`;
  - `REJECTED` stays non-retryable.
- **`integ/local` (runtime):** the existing admission-limit and continuity cases assert the in-band refusal instead of a `REJECTED` task.
- **`integ/aws/agentcore`:** the pass-through assertion above. Nothing new in e2e.

## Docs

- ARCHITECTURE:
  - §2's mechanical invariants: "refused, retryably, never queued";
  - the state table's `REJECTED` row;
  - the start sequence.
- GLOSSARY: a *refusal* entry; the continuity key's entry points at it.
- ADR 0007: "rejected loudly" becomes "refused loudly, retryable once the task ends". Mutated in place, and the commit says so.
- ROADMAP A4 progress.
