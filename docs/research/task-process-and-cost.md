# The task process: protocol, cancellation and cost — spike findings

**Measured on 2026-09-22.** Bun 1.4.0, macOS arm64 (Apple Silicon), 8-core. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §G in full and §C's **local** half; §C's platform half is blocked with §B (see §B's note). No model spend.

Source: `spikes/task-process/`, an executor and a task process speaking the real protocol. Ten cases, nine confirmed and one measured.

> **Read the numbers as a floor, not a forecast.** They come from a developer Mac, not the 2 vCPU / 8 GB ARM64 microVM an agent runs in, and the task process here imports the Agent SDK without spawning the Claude Code CLI a real run spawns. The *shape* of each result is what transfers; the absolute figures are re-measured on AgentCore.

---

## The channel

**A dedicated bidirectional socketpair on fd 3**, `stdio: ['ignore', 'pipe', 'pipe', 'socket-fd']` with `detached: true`, read from the parent with `net.connect({ fd })`. JSON-RPC 2.0, one message per line.

`"socket-fd"` at index ≥ 3 is the mechanism: Bun creates a socketpair, and the parent-end fd it exposes on `Subprocess.stdio[3]` is caller-owned and never closed by the child — which is what lets `net.connect({ fd })` take it. A plain `"pipe"` would be one-directional and would not carry `cancel` inward.

**The separation is real, not nominal.** The task wrote to stdout a line *shaped like a protocol response* claiming `outcome: "SABOTAGE"`, and the executor still read `outcome: "SUCCEEDED"` from fd 3. A shared channel is how a task's logging corrupts its own outcome; a dedicated one makes that unexpressible.

**The version handshake is a plain request/response** and costs one round trip before any work. Note honestly what this does and does not show: it demonstrates the handshake is available and cheap, and that a mismatched version can be refused before `run` is ever sent. Nothing in the platform enforces it — the discipline is AgentForge's, and the test asserts AgentForge's own rule.

## Cancellation (§C, local)

| Case | Result |
|---|---|
| `cancel` over the protocol settles the run gracefully | **5 ms** to a cancelled outcome, after 4 progress events |
| A task that ignores `SIGTERM` is killed after the grace period | terminated at **511 ms** against a 500 ms grace, `signal = SIGKILL` |
| `SIGKILL` of the **process group** takes a grandchild the task started | grandchild stopped: 6 lines at the kill, **6** lines 1.5 s later |
| **Negative control** — killing the process alone | grandchild **survived**: 6 lines at the kill, **13** lines 1.5 s later |
| A cancel arriving **before** the task process exists | caught by a token set before the executor's first `await`; nothing spawned |

**The process group is load-bearing, and the negative control is why it is worth stating.** `detached: true` calls `setsid()`, so the child leads its own group; `process.kill(-pid, …)` then signals the group. Kill the process alone and its grandchildren keep running — which is exactly the reproduced failure "a cancelled task leaving subprocesses behind" (`ARCHITECTURE.md` §9). Both halves were observed in the same run, on the same fixture, minutes apart.

**A task that ignores `SIGTERM` cannot be handled any other way.** A no-op handler *replaces* the default disposition, so the process survives `SIGTERM` indefinitely. The grace period plus a group `SIGKILL` is the only mechanism, and it terminated the process within 11 ms of the deadline.

**The cancel-before-spawn window has no hole** as long as the token is set before the executor's first `await`. This is the same discipline as publishing `submitted` synchronously ([a2a-server-assembly.md](a2a-server-assembly.md)): the executor's first suspension point is where both races live.

## Health and cost (§G)

### `/ping` is untouched by running tasks

40 samples each, against a server on its own event loop:

| | p50 | p95 | max |
|---|---|---|---|
| idle | 0.52 ms | 1.32 ms | 1.75 ms |
| 4 tasks running, **2 of them saturating a core** | 0.16 ms | 0.18 ms | 0.27 ms |

Busy was *faster* than idle — warm-up, not an effect. What matters is that two CPU-saturating tasks moved p95 not at all. **§REQ707 holds because the tasks are separate processes**, not because of anything the executor does. This is the strongest single argument for ADR 0004: a task cannot stall the health check and get a busy session reaped, by construction.

### A process per task is close to free

Median of five spawns, measured from the parent's spawn instant to the task's `hello` response:

| | ready to serve | of which |
|---|---|---|
| bare process | **15 ms** | 12 ms module load |
| with `@anthropic-ai/claude-agent-sdk` imported | **65 ms** | 51 ms SDK import |

Against a 120-second run — conservative for either consumer, whose procedures are minutes — that is **0.054 % overhead**. **ADR 0004 stands on these numbers.** Even at ten times this cost on a slower ARM64 microVM it would not be the reason to share a process.

### Per-task memory, and what it means for the admission limit

Six tasks alive at once, each with the SDK imported: **≈ 61 MB RSS each**, ≈ 368 MB total. At 60 % of an 8 GB container that is **≈ 80 tasks** before the ceiling.

**Do not use 80 as the admission limit.** Three reasons, in descending order of importance:

1. **A real task also spawns the Claude Code CLI**, which this fixture does not. The CLI is the dominant cost, and it is not in this number.
2. RSS double-counts shared pages across processes, so the true total is lower — which cuts the other way and is the smaller error.
3. The limit exists because "an out-of-memory kill takes the whole session with it" (`ARCHITECTURE.md` §2). A limit derived from a harness floor would be set from the wrong number in the unsafe direction.

What this measurement *does* establish is that **the per-task fixed cost is tens of megabytes, not hundreds** — so the admission limit will be governed by what a procedure's agent run costs, not by the process-per-task decision. The real figure is measured on AgentCore with a real run.

### A correction worth recording

The first run of this measurement reported 27.9 MB across "15 tasks" from six spawns. The cause was `ps -o rss= <pid> <pid> …`: macOS `ps` ignores bare pid operands and lists the session instead. The case now asserts `rows === spawned` and reports `SUSPECT` when they differ, because a number that looks plausible is the easiest kind of wrong answer to record as fact.

---

## What this settles

- **§G is settled.** ADR 0004 is confirmed with numbers: 65 ms of startup against minutes of run, and `/ping` provably unaffected by saturated tasks.
- **§C's local half is settled**: the protocol over a dedicated socketpair, graceful cancel, `SIGTERM` then a group `SIGKILL`, and the cancel-before-spawn token. All three cases `ARCHITECTURE.md` §4 requires are covered, with the third — a cancel reaching a freshly provisioned container — belonging to the platform half.
- **§C's platform half is not settled** and could not be attempted: `StopRuntimeSession` behaviour, whether the container receives `SIGTERM` and how long before the kill, whether telemetry flushes inside the grace period, and whether a Claude session left mid-turn resumes cleanly. All blocked with §B.
