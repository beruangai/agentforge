# Proposal

## Why

The A4 audit (A9, A11) found that three refusals a container gives are temporary but end the task as `TASK_STATE_REJECTED`:

- a container that is stopping;
- a container at its admission limit;
- a continuity key under which a task is still running.

The Temporal activity makes `REJECTED` non-retryable, since it is meant for what can never succeed. So a workflow fails outright on a condition that clears within seconds or minutes. A refusal that can clear must say so, and say when to try again (§REQ306).

These refusals can't be HTTP statuses. AgentCore turns any non-2xx container response into an opaque HTTP 424 `-32055`, the same as a crash, and passes no container headers back. That code is also the one the client already retries while a session's container is created. A 503 or 429 with `Retry-After` would never reach a caller on AgentCore. A JSON-RPC error on HTTP 200 does pass through intact, which is how the readiness probe's "Task not found" arrives. It is also A2A's own convention.

## What Changes

- A temporary refusal is answered **in-band**: a JSON-RPC error on HTTP 200, the same locally and on AgentCore (§REQ701). It creates **no task and binds no idempotency key**, so a retry under the same key is a fresh start.

| Refusal | Code | When to retry |
|---|---|---|
| The container is stopping | `SERVICE_UNAVAILABLE` | After a few seconds. The platform already routes the session's next call to a fresh container. |
| The container is at its admission limit | `TOO_MANY_REQUESTS` | After a fixed 600 s |
| A task under the continuity key is running | `TOO_MANY_REQUESTS` | Once the running task's remaining time budget has passed; it can't run longer |

- Each refusal carries its reason and `retryAfterSeconds`.
- The client throws a refusal as a typed error carrying when to retry.
- The Temporal activity waits out refusals itself, for up to 15 minutes of waiting per attempt, starting again under the same key. Past that, it fails **retryable**, with Temporal's next retry delayed to the refusal's time.
- `TASK_STATE_REJECTED` is kept only for what can never succeed: an unknown procedure, a contract hash mismatch, invalid input (including an input over its cap).
- A continuity key still names *different* tasks that must not overlap. The idempotency key alone names the same task. Once the running task ends, the refused start runs as a new task, and a caller that wants the running task's result retries with its idempotency key, which attaches.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `runtime-task-admission`: the admission limit, a running continuity key and a stopping container refuse a start in-band and retryably, with no task. `TASK_STATE_REJECTED` is only what can never succeed.
- `client-task-calls`: the client throws a temporary refusal with its retry time, and the activity retries after it.

## Impact

- **Wire.** Two JSON-RPC error codes and their data, defined once in `core/` for the server and the client.
- **Server.** The gateway answers the three refusals in-band. The executor's refusal of a start that raced the container's stop becomes the same in-band refusal.
- **Client and activity.** A typed refusal error. The activity maps it to a retryable failure with a next-retry delay.
- **Callers.**
  - Refusals are waited out inside the activity first, so `startToCloseTimeout` must also cover up to 15 minutes of waiting. Past that, each spent budget is an attempt, and each wait between attempts counts toward `scheduleToCloseTimeout`. A caller sets those, and any workflow timeout, wide enough, or leaves them unset.
  - Temporal can't widen an activity's timeouts once it is scheduled.
  - `procedureActivity` and the README say so.
- **Docs.** ARCHITECTURE's admission paragraph and state table, the glossary's continuity key entry, and ADR 0007's "rejected loudly" (mutated in place: no consumer depends on it yet).
- No table or construct change.

## Success criteria

- A start refused for any of the three reasons leaves no task and no key binding. A retry after the stated time runs normally.
- On AgentCore, the refusal reaches the caller with its code, reason and retry time, not as `-32055`.
- The Temporal activity waits out a refused start within its budget, then retries after the stated delay. It still fails non-retryable on `TASK_STATE_REJECTED`.

## Non-goals

- The client doesn't retry refusals itself. The activity is the retry policy AgentForge ships.
- No metric for refusals. The caller is told, and the server logs each one with its reason.
- No queueing (§REQ306).
