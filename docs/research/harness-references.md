# Harness References

Three projects that wrap an agent SDK behind a protocol boundary. **None is a dependency and none is a model for this architecture.** Each is here for the specific mechanics worth borrowing when the corresponding part is built, and for nothing else. All three are young; verify anything before taking it.

---

## `temporal-agent-harness`

Read at `d7a55f8` (v0.4.0, pre-alpha) on 2026-09-20. Python; the whole agent loop is a Temporal workflow, with the model SDK's reason-act loop running inside the workflow sandbox and model calls dispatched as activities.

**Why it is not a model here:** that one decision produces almost everything distinctive about it, and it is the decision we did not take. The Claude Agent SDK is a subprocess doing its own I/O and tool dispatch, so there is no seam to stub. Its streaming, its cross-agent stream merge, its Nexus tool transport and its replay story are all consequences of that architecture rather than answers to our problem.

**Worth borrowing:**

- **Driving a remote agent turn from an activity.** Heartbeat a resume memo from a background task at half the heartbeat timeout rather than off stream events, which are sparse and unpredictable; put **no timeout on the turn itself** and let the heartbeat window carry liveness; treat the memo's *presence* as the already-sent flag, so a crashed attempt resumes consuming rather than re-sending. This is our Temporal activity factory, written in another language.
- **An idempotency key derived from activity identity** — `workflow_run_id` plus `activity_id`, stable across attempts. The same construction [ADR 0009](../../adr/0009-the-caller-supplies-the-idempotency-key.md) specifies for the factory's default.
- **Admission and execution as two halves, with the stream cursor as an *output* of the accept** — never an input, so a caller cannot supply a stale one after the side effect happened. The cursor is read from the real log head rather than a publish counter.
- **Envelope-stamped routing metadata.** Producers build only the payload; identity and timestamps are stamped by the layer that owns them. Raw provider tokens are folded into semantic events before they cross any boundary.
- **The control plane excluded from the discovered interface**, so a calling agent cannot answer a gate meant for a human.
- **A frozen, serializable approval policy required at construction** — a tool only asserts that it is safe, an ordered policy decides, and the builder refuses to build without a default. They shipped the fail-open version first and had to invert it.
- **Validators that reject before state changes**, so a malformed answer does not consume a one-shot gate.
- **Provider throttling read from response headers** — `retry-after-ms`, `retry-after`, `x-should-retry` — propagated as the next retry delay, with the client's own retries disabled so the durable layer owns them.

**Worth knowing, from their mistakes:** every event on a wire needs a monotonic per-stream sequence number, because their UI silently drops byte-identical events for lack of one; cap payloads at the producer; and if work ever fans out, each sub-stream needs its own cursor from the start.

**What it buys that we cannot have:** an unbounded pause that costs nothing while parked, because replay rebuilds the conversation and the position in the tool loop. Every human-in-the-loop feature they have rests on it. One task is one process here, and AgentCore caps a job at 8 hours — which is why [`DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §M exists rather than a copy of their design.

---

## `a2a-claude`

Read at `a2a-claude@0.4.1` with `@a2a-wrapper/core@2.1.1`, 2026-09-17. An A2A server wrapping the Claude Agent SDK.

**Worth borrowing:**

- **Background-task tracking** (`src/claude/background-tasks.ts`, ~70 lines) — it reads the SDK's `system/background_tasks_changed` message, a level signal carrying the full set of live background tasks with replace semantics, so a missed start or finish cannot wedge a stale "still running". One tracker per query, since the signal is per CLI process. Relevant only if background agent work is ever enabled; §E decides that.
- **Cancellation** — abort plus `query.interrupt()`, with exactly one terminal event published, guarding the abort path from publishing a second.
- **Streaming input keeps the CLI's stdin open** — a plain string prompt makes the SDK close stdin at the first result, ending the process before a late wake-up can fire.

**Not worth borrowing:** options built from static configuration with no per-request seam, no structured output, no hooks, no telemetry, and a task store hard-coded in memory.

---

## `claude-a2a`

Read at `ericabouaf/claude-a2a`, `src/executor.ts`, 2026-09-20. Explicitly experimental.

**Worth borrowing:**

- **Rejecting rather than queueing** — a message to a task that is still working is refused, which is the same choice made here for a continuity key a live task holds.
- **A persisted context-to-session map**, so multi-turn conversations survive a restart.
- **Cancellation** — `interrupt()` raced against a timeout, then abort, with a flag suppressing further status publishing.

**Not worth borrowing:** it treats the first `result` message as final, which is the settlement bug that cost the predecessor harness a day; it runs queries in the server's own process; and its input-required parking depends on internal event-bus behavior of the A2A SDK that its own comments call fragile.
