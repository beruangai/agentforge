# Roadmap

Each milestone ends with capability verified end to end on **AgentForge's own example agents** (`examples/`), before any consumer adopts it. A consumer never finds a failure an example could have found.

## A0 — Scaffold and blocking decisions

**Delivered 2026-09-23.** One Nx project that is the published package; entry points behind export conditions; the test tiers; the ADRs; the platform spikes that the design rests on, as integration tests where their answers can drift.

## A1 — A working agent, locally

**Delivered 2026-09-25**, on `hello-agent`, against a real model.

- Contracts as oRPC, the contract hash, the time budget in contract meta; `implementAgent` and `context.runAgent`; `composeOptions` with additive guardrails (§REQ101–§REQ104, §REQ201–§REQ206)
- The kernel: streaming input, structured output, one outcome, classification from fields, interrupt then abort, dead-guardrail detection, a record per run (§REQ206, §REQ501, §REQ601)
- The runtime: A2A 1.0 server, gateway (idempotent attach, attempts, admission, continuity, session check), executor (a process per task over IPC, time budget, lease, group kill), DynamoDB task store with derived loss (§REQ301–§REQ306)
- The client over a local container or AgentCore, and the Temporal activity (§REQ301, §REQ305)
- The base image and the agent image from the lockfile
- `hello-agent`'s e2e: a typed output, a resumed session in the same container, an idempotent attach, a cancel mid-Bash; the Temporal activity completing and cancelling

**Not in A1, and why**: cross-container resume (§F — needs the S3 `SessionStore`, and one container resumes today); telemetry and metrics (§T, with A2's dashboard); generators (§K, once a second agent shows what to generate).

## A2 — The same agent on AgentCore

**Started 2026-09-25**: AgentForge's server runs on a V2 runtime in `us-east-2`, reached through `agentCoreTransport`, with task state in DynamoDB — a typed output and an attach, a cancel, and a `StopRuntimeSession` ending the task `LOST` with the retry running as attempt 2 (`integ/aws/agentcore/agentforge-runtime.test.ts`, no model).

- The construct and deploy path (§D): runtime on V2, its role, the task table, the leaf image in ECR, a deploy that waits for `READY`
- The uuid-after-restore spike (§H) and the admission default measured (§G)
- `hello-agent`'s e2e against the deployed runtime through `agentCoreTransport`, including a container stop mid-task ending `LOST` and a retry attaching
- Telemetry and per-agent metrics (§T)
- Cross-container resume (§F), if a consumer needs it before A4

**Exit:** the same procedure, unchanged, runs against a deployed agent and survives a container stop.

## A3 — Built-in capabilities

Common guardrails a procedure opts into rather than writes, each acting **within the agent's turn** so the agent can fix what it finds before it answers — never a check after the run that can only fail it.

- A stop guard for predefined cases: the files the procedure expects exist, before the agent may stop
- Each lands on an example agent first; what it needs enters [REQUIREMENTS.md](REQUIREMENTS.md) through the operator

## A4 — Consumers

- StrategyFoundry adopts; TrendBot migrates off its predecessor harness
- What either lacks enters [REQUIREMENTS.md](REQUIREMENTS.md) through the operator, and lands on an example first
- The plugin's generators and sync generator (§K), extracted from what the examples and the first consumer wired by hand
