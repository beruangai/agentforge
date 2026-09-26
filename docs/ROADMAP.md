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

- The construct and deploy path: runtime on V2, its role, the task table, the leaf image in ECR, a deploy that waits until the runtime serves. **Built 2026-09-25** as `AgentRuntime`, verified by `agentforge-runtime.test.ts` deploying through it
- Ids minted after a V2 restore are distinct. **Settled 2026-09-26**: Bun's generator replays across restores once drawn from before the snapshot, so the server draws nothing before it; the same test, deployed with a secret and telemetry, re-checks it
- The admission default measured (§G). **Settled 2026-09-26**: 4 kept, ~165 MB per running task measured
- `hello-agent`'s e2e against the deployed runtime through `agentCoreTransport`, including a container stop mid-task ending `LOST` and a retry attaching. **Built 2026-09-26** as `e2e-agentcore`
- Telemetry and per-agent metrics (§T). **The CLI's telemetry built 2026-09-26** (AgentCore Observability, the ADOT collector, levels), **its `gen_ai.*` mapping 2026-09-27**, and **the per-agent counts and dashboard 2026-09-27** (§REQ604); a transcript view waits on the CLI (§T)
- Sessions persist beyond their container (§REQ402): every transcript in the agent's session bucket through the SDK's `SessionStore`, so a session outlives the container and a later task resumes it in another. **Built 2026-09-27**: `hello-agent`'s AgentCore e2e resumes a session in another container after its own is stopped

**Exit:** the same procedure, unchanged, runs against a deployed agent and survives a container stop, and its session persists beyond the container and resumes in another.

## A3 — Built-in capabilities

Each lands on an example agent first; what it needs enters [REQUIREMENTS.md](REQUIREMENTS.md) through the operator.

- Working directories (§REQ401, [ADR 0015](../adr/0015-working-directories-sync-a-prefix-per-task.md)), the optional filesystem AgentForge manages for a consumer's artifacts: a `WorkingDirectory` construct several agents share, a prefix per task pulled and pushed under a strategy the consumer declares, the outcome waiting for a verified push. **Built 2026-09-27**: `hello-agent` keeps a note in one container and reads it back in another
- Guardrails a procedure opts into rather than writes, each acting **within the agent's turn** so the agent can fix what it finds before it answers — never a check after the run that can only fail it. First, a stop guard for predefined cases: the files the procedure expects exist before the agent may stop. To be designed with the operator

## A4 — Consumers

- StrategyFoundry adopts; TrendBot migrates off its predecessor harness
- TrendBot's vault on working directories, which confirms or amends ADR 0015
- What either lacks enters [REQUIREMENTS.md](REQUIREMENTS.md) through the operator, and lands on an example first
- A second example in the plugin's shape — an agentic project with nested agents, each layer its own image — built by hand first; `hello-agent` stays flat, the minimal consumer. **Built 2026-09-25** as [`examples/agentic-project`](../examples/agentic-project): `reviewer` and `fixer` over a shared skill, `CLAUDE.md`, MCP server and house options, each layer a member of the container workspace, verified end to end
- The plugin's generators and sync generator (§K), designed from that example, which the plugin then manages in this repository so its sync and updates are dogfooded here
