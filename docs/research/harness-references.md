# Harness References

Two open-source projects wrap the Claude Agent SDK behind A2A. **Neither is a dependency and neither is a model for this architecture.** They are worth a look only for the specific mechanics noted below, when the corresponding part is built. Both are young, single-author projects; verify anything before borrowing it.

## `a2a-claude`

Read at `a2a-claude@0.4.1` with `@a2a-wrapper/core@2.1.1`, 2026-09-17.

Worth a look for:

- **Background-task tracking** (`src/claude/background-tasks.ts`, ~70 lines) — it reads the SDK's `system/background_tasks_changed` message, a level signal carrying the full set of live background tasks with replace semantics, so a missed start or finish cannot wedge a stale "still running". One tracker per query, since the signal is per CLI process. Relevant only if background agent work is ever enabled; the settlement spike (`../DESIGN_OPTIONS.md` §E) decides that.
- **Cancellation** — abort plus `query.interrupt()`, with exactly one terminal event published, guarding the abort path from publishing a second.
- **Streaming input keeps the CLI's stdin open** — a plain string prompt makes the SDK close stdin at the first result, ending the process before a late wake-up can fire.

Not worth borrowing: options built from static configuration with no per-request seam, no structured output, no hooks, no telemetry, and a task store hard-coded in memory.

## `claude-a2a`

Read at `ericabouaf/claude-a2a`, `src/executor.ts`, 2026-09-20. Explicitly experimental and not for production.

Worth a look for:

- **Rejecting rather than queueing** — a message to a task that is still working is refused with `UnsupportedOperationError`, which is the same choice made here for a Claude session that a live task holds.
- **A persisted context-to-session map**, so multi-turn conversations survive a restart.
- **Cancellation** — `interrupt()` raced against a timeout, then abort, with a flag suppressing further status publishing.

Not worth borrowing: it treats the first `result` message as final, which is exactly the settlement bug that cost the first AgentForge a day; it runs queries in the server's own process; and its "input-required" parking depends on internal event-bus behavior of the A2A SDK, which its own comments call fragile.
