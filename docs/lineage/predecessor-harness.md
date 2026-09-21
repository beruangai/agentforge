# The Predecessor Harness

TrendBot runs today on a harness inside its own monorepo, at `~/workspace/PlayTek/trendbot-monorepo/packages/agentforge`. It shares a name with AgentForge and is not it — a proof of the idea, built one fix at a time inside one consumer. It is **evidence, not a specification**: what was tried, and what it cost. Nothing here is a design constraint; the requirements it implies are the consumers', in their contracts. Read at 2026-09-17.

## The failures that became tests

Each of these cost hours to days in production. Each is a failure-injection test in [`ARCHITECTURE.md`](../ARCHITECTURE.md) §8, in the layer that owns it.

| What happened | Why it could |
|---|---|
| A worker was redeployed mid-run; the agent finished, committed its work, and replied to a worker that no longer existed. Temporal noticed at the 30-minute timeout | The result lived only in an open HTTP request |
| Containers were killed mid-run (AgentCore 424), 30–55 seconds in, surfacing as an unparseable response and consuming retries | No record of the run existed outside the container |
| Runs needed up to two hours against a 15-minute synchronous request cap | One synchronous request held for the whole run |
| `/ping` stalled 0.5–4.4 seconds by synchronous git spawns, `Atomics.wait` backoff and per-message logging, getting busy sessions terminated | The health check shared an event loop with the run |
| A timed-out attempt kept running while its retry started, and could commit twice | No cancellation, no idempotency, no heartbeat |
| Research dispatched subagents in the background; on the turns resumed when that work finished, the artifact write and the final structured-output call were cancelled. Five entities failed | Background agent work, and a result taken before it settled |
| Structured output lost to schema conversion: `$defs`, `format`, `$schema`, `const` and `enum` each needed a workaround discovered from a failure | Conversion quirks between Zod, the SDK, and the backend |
| `maxTurns` and `allowedTools` were accepted in the input schema and never passed to the SDK | Nothing checked that an accepted option reached the run |

## What earned its place

Re-verify each against the current SDK before porting — the settlement spike ([`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §E) exists for this.

- **Three layers of output validation:** a `PreToolUse` hook running Zod against the submission and denying with a readable error so the agent corrects in-turn; the CLI's own retry cap; a final parse of the settled result.
- **Settlement details:** recovering a structured-output submission the CLI dropped on a resumed turn; routing an error status carried on a success envelope to an error; keeping all agent work in the foreground.
- **Error classification:** transient on 408, 409, 429, 5xx and 529 — by message text where the SDK leaves the status null — with jittered backoff and session resume.
- **Guardrails:** write scope on edits; a stop guard that blocks ending while a required artifact is missing; disclosure of the active rules to the agent, derived from what is enforced.
- **Telemetry:** the CLI's native OpenTelemetry exported to an in-container collector, remapped to GenAI semantic conventions, and drained before the result returned.
- **Failure detail to Temporal:** non-retryable application failures carrying container logs, truncated.

## Why it is not the shape to copy

It grew one fix at a time until the AgentCore transport, the container, execution control and TrendBot's own use case were a single layer. The most-fixed areas — the transport envelope, waiting for the final response, structured-output marshalling, error classification, observability — are the seams that were never drawn. Drawing them is this workspace's premise ([ADR 0001](../../adr/0001-four-layers-with-contracts-at-the-boundaries.md)).

TrendBot's in-flight drafts in its `openspec/changes/` respond to the same failures with mechanisms that are not adopted here: a job token with polling and a payload-hash idempotency key, and a front server proxying `/ping` to an inner one. Take their problem statements as evidence; the answers are in [`ARCHITECTURE.md`](../ARCHITECTURE.md).
