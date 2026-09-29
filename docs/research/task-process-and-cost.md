# A process per task — what it costs

**Measured 2026-09-22** on Bun 1.4.0, locally; the evidence for [ADR 0004](../../adr/0004-a-process-per-task.md). The channel measured then was a socketpair on fd 3; the implementation now uses Node IPC, which changes none of these numbers' conclusions.

- **Startup is close to free.** Median of five spawns to a task ready to serve: 15 ms bare, **65 ms with the Agent SDK imported** (51 ms of it the import) — 0.054 % of a two-minute run.
- **`/ping` is untouched by running tasks.** With four tasks running, two saturating a core, `/ping` p95 was 0.18 ms (idle: 1.32 ms). The health check cannot be stalled by a task, by construction.
- **A task's fixed memory is tens of megabytes**: ≈ 61 MB RSS each with the SDK imported. The admission limit is governed by what the Claude CLI and the agent's tools cost, which this did not include — so it is measured on AgentCore with real runs (`ARCHITECTURE.md` §2, measured 2026-09-26), never derived from this number.
- `ps -o rss= <pid> …` on macOS ignores bare pid operands and lists the session; count rows against spawned processes before trusting a memory figure.
