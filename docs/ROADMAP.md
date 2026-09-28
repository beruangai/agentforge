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

**Delivered 2026-09-27**, on `hello-agent`, against a real model; its retroactive OpenSpec specs move to A4. Started 2026-09-25: AgentForge's server runs on a V2 runtime in `us-east-2`, reached through `agentCoreTransport`, with task state in DynamoDB — a typed output and an attach, a cancel, and a `StopRuntimeSession` ending the task `LOST` with the retry running as attempt 2 (`integ/aws/agentcore/agentforge-runtime.test.ts`, no model).

- The construct and deploy path: runtime on V2, its role, the task table, the leaf image in ECR, a deploy that waits until the runtime serves. **Built 2026-09-25** as `AgentRuntime`, verified by `agentforge-runtime.test.ts` deploying through it
- Ids minted after a V2 restore are distinct. **Settled 2026-09-26**: Bun's generator replays across restores once drawn from before the snapshot, so the server draws nothing before it; the same test, deployed with a secret and telemetry, re-checks it
- The admission default measured (§G). **Settled 2026-09-26**: 4 kept, ~165 MB per running task measured
- `hello-agent`'s e2e against the deployed runtime through `agentCoreTransport`, including a container stop mid-task ending `LOST` and a retry attaching. **Built 2026-09-26** as `e2e-agentcore`
- Telemetry and per-agent metrics (§T). **The CLI's telemetry built 2026-09-26** (AgentCore Observability, the ADOT collector, levels), **its `gen_ai.*` mapping 2026-09-27**, and **the per-agent counts and dashboard 2026-09-27** (§REQ604); a transcript view waits on the CLI (§T)
- Sessions persist beyond their container (§REQ402): every transcript in the agent's session bucket through the SDK's `SessionStore`, so a session outlives the container and a later task resumes it in another. **Built 2026-09-27**: `hello-agent`'s AgentCore e2e resumes a session in another container after its own is stopped

**Exit:** the same procedure, unchanged, runs against a deployed agent and survives a container stop, and its session persists beyond the container and resumes in another.

## A3 — Built-in capabilities: filesystems

**Delivered 2026-09-28**, on `hello-agent`.

- Filesystems (§REQ401, [ADR 0015](../adr/0015-filesystems-mount-around-a-procedure.md)): an abstract kind AgentForge mounts around a procedure, registered by middleware, scoped per request, the outcome waiting for a verified push. `S3Filesystem` on `s7cmd` over an `S3FilesystemBucket` several agents share, and `ScratchFilesystem`; git later. Specified by [`openspec/specs/filesystem-lifecycle`](../openspec/specs/filesystem-lifecycle/spec.md). **Built 2026-09-28**: `integ/aws/filesystem-s3-sync` against `s7cmd` in the base image, and `hello-agent`'s AgentCore e2e keeps a note in one container and reads it back in another on the baseline permissions alone

## A4 — Specs and audit

- Retroactive OpenSpec specs for what A1 and A2 built, beside `filesystem-lifecycle` in `openspec/specs/` — succinct, significant behaviour only — written with the operator. **Landed 2026-09-28**: eight specs, each at its highest seam, their scenarios mapped to tests and the untested ones flagged in the [archived change](../openspec/changes/archive/2026-09-28-retroactive-specs/design.md)
- A full audit of the package, the examples and the docs for cohesion, correctness, simplicity and maintainability: layer contracts and ownership, naming and terms, dead or duplicated code, docs that no longer match the code (among them the project-key pinning `docs/research/claude-agent-sdk.md` describes and ADR 0011 does not). What it finds is fixed, or raised with the operator where it is a decision

**Exit:** every built capability has a spec, and the audit's findings are closed or decided.

## A5 — The Nx plugin

- The plugin's generators and sync generator (§K). [`examples/agentic-project`](../examples/agentic-project) — built by hand 2026-09-25: `reviewer` and `fixer` over a shared skill, `CLAUDE.md`, MCP server and house options, each layer a member of the container workspace — shows what to generate, but it is not the target state: the plugin generates an improved one, regenerating `agentic-project` or a sibling that retires it. `hello-agent` stays flat, the minimal consumer
- Iterated with the operator capability by capability, so each generates and syncs as a consumer's adoption needs
- The plugin manages its examples in this repository, so its sync and updates are dogfooded here

**Exit:** a generated agentic project, synced by the plugin, runs end to end as `agentic-project` does today.

## A6 — Before the first live consumer

- What StrategyFoundry needs before it can adopt — to be established with the operator — and the further built-in capabilities wanted before any consumer is live
- Guardrails a procedure opts into rather than writes, each acting **within the agent's turn** so the agent can fix what it finds before it answers — never a check after the run that can only fail it. First, a stop guard for predefined cases: the files the procedure expects exist before the agent may stop. To be designed with the operator
- What it needs enters [REQUIREMENTS.md](REQUIREMENTS.md) through the operator, and lands on an example first

## A7 — StrategyFoundry, locally

- StrategyFoundry has not started development; AgentForge is part of its foundational scaffolding, generated by the plugin
- Both projects are developed locally with AgentForge linked (`bun link`), and the gaps StrategyFoundry finds are closed in AgentForge, each on an example first
- A fresh codebase whose workspace is S3, so it vets filesystems and ADR 0015

## A8 — CI/CD and publishing

- CI for the package and its examples, and publishing the package — to GitHub Packages or npm — so a consumer deploys from a published version rather than a local link

## Later

- TrendBot migrates off its predecessor harness only after StrategyFoundry has vetted AgentForge. Its vault is a git-backed filesystem: before it can adopt, either AgentForge adds a git filesystem kind or TrendBot subclasses `Filesystem` itself
