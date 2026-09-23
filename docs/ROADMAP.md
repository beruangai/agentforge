# Roadmap

Milestones deliver capability a consumer can actually run. The questions each depends on in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md) are settled first — by spike where they turn on platform behavior.

**A milestone that delivers behavior is proposed through OpenSpec; A0 is not.** A0 is the workspace itself — layout, targets, tooling, and retiring `spikes/` — and has no behavior contract to write, so it is done directly. `openspec/specs/` begins with A1.

**StrategyFoundry's M0 is its own lowest bar, not this roadmap's target.** A milestone here ends with agents that execute real work reliably, not with a foundation that compiles.

## A0 — Scaffold, blocking decisions, local spikes

**Delivered 2026-09-23.** The workspace builds, `spikes/` is gone, and every spike is a test or a research note.

- Nx workspace on current `@aws/nx-plugin` defaults — Bun, Biome, catalog versions — as **one project, `packages/agentforge`, which is the one published package**, with concepts as sub-module folders rather than projects (`ARCHITECTURE.md` §10). TypeScript 6 and vitest 4, because Nx cannot yet run TypeScript 7 and `@nx/vitest` stops at vitest 4 ([research](research/aws-nx-plugin.md))
- **The entry points and their boundary**: `/contract`, `/client`, `/temporal`, `/agent`, `/infra`, bundled by tsdown with shared chunks; `/agent` gated by the `agentforge-agent` export condition, tested under Node, TypeScript and Bun
- **Three test tiers as separate targets**: `test`, `integ`, `e2e`
- `@aws/nx-plugin`'s preset and `ts#sync` read ([research](research/aws-nx-plugin.md)); **`ts#agent` deferred with §K** — what AgentForge's generators write waits for the first agent, and reading it now is reading against no requirement
- **The blocking decisions are made**: the A2A server is assembled rather than inherited ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md), §I), it speaks 1.0 only ([ADR 0014](../adr/0014-agentforge-speaks-a2a-1-0-only.md)), a procedure is an oRPC contract ([ADR 0013](../adr/0013-a-procedure-is-an-orpc-contract.md), §N), and the task store is one task item plus a tiny index item (§A)
- **Landed:** kernel settlement (§E), the task-process protocol with cancellation and group kill (§C, §G), deterministic image builds (§D), the procedure framework (§N), capability composition (§L/§REQ203), and the AgentCore behaviour §A, §B, §C and §I rested on
- **No spike is outstanding.** §O's first slice classifies `CREDENTIAL_EXPIRED` and does nothing more, which needs no measurement; the one unrun spike — session resume across containers (§F) — needs an agent that does not exist until A1
- **`spikes/` is triaged and removed**, per the disposition decided before A0: kernel settlement → `e2e/`; AgentCore, A2A version negotiation, the procedure framework, capability composition, image and bundler determinism, and `s7cmd` sync → `integ/`; task-process, server assembly and procedure authoring retired to their research notes, with the code in git history at `d3f08b7`
- **Run at A0**: every test that needs neither AWS nor a model — procedure framework, capability composition, A2A version negotiation, image determinism
- **AgentCore and `s7cmd` sync, first run 2026-09-24**, in `us-east-2` as the test-only `AgentForgeTestInteg` role (tests never run in prod's `us-west-2`): every file passes, the AgentCore files in parallel. Two findings came of it — the pre-warmed pool seen on 2026-09-22 did not reproduce, and nothing depends on it; and a timing race in the busy-container test was fixed. The integ tier was then cut to what AgentForge relies on and the platform does not guarantee (`.claude/rules/testing.md`): container-per-session, the header allowlist and the lease read-back moved to research notes
- **Written but not yet run**: the kernel-settlement e2e tests, which spend on a model

**Exit:** the workspace builds; `spikes/` is gone; every A0 question is closed or explicitly deferred with its reason; each spike whose answer can drift is an integration test and each that settled a decision once is an ADR or a dated research note (`ARCHITECTURE.md` §9).

## A1 — A working agent, locally

The whole loop, in Docker, for a procedure a consumer would actually ship.

- Task protocol: envelope, identifiers, events, outcome
- Procedures: the oRPC contract and its derived calls, the contract hash, the run with its prompt, options, agent contract and marshal, and the before and after steps (§REQ101–§REQ104, §REQ201, §REQ205)
- Kernel: structured input and output throughout, settlement, abort, session start, resume and fork (§REQ103, §REQ206, §REQ402)
- Guardrail hooks composing without loss, and telemetry (§REQ204, §REQ602)
- Runtime: A2A server, gateway and executor, a process per task, filesystem task store behind the fenced interface, generated agent card
- Caller-agnostic client and the Temporal activity factory: `SendMessage` starting or attaching, `GetTask` polled to a terminal state with a heartbeat, `CancelTask` (§REQ301, §REQ304, §REQ305)
- Typed outcomes with their causes, and what every task records (§REQ501, §REQ601)
- Base image, and one agentic base image with an agent over it, built locally; the `SessionStore` adapter and the workspace sync helper against a local object store; credentials provisioned as §O decides (§REQ402, §REQ705)
- Failure-injection tests for every layer-2 failure in `ARCHITECTURE.md` §9

**Exit:** a StrategyFoundry workflow runs a real procedure against a local container, gets validated structured output, and can cancel it, retry it, and resume its session — with the run's prompt, options, transcript and usage recorded.

## A2 — The same agent on AgentCore

- The one AgentCore question left: session resume across containers (§F). Reachability (§B), cancellation (§C) and the store's lease (§A) were answered in A0
- A2A client over `InvokeAgentRuntime` with SigV4 and 409 retry; durable task store; idempotency, lease and loss; admission limits
- The Nx plugin: generators for an agentic project, an agentic base image, an agent, a procedure and a caller's wiring, plus the sync generator (§K)
- CDK constructs and the deploy path: the local `FROM` chain as Nx tasks, and an update only for the agents Nx rebuilt (§D)
- Failure-injection tests for every layer-1 failure, on AgentCore

**Exit:** the same procedure, unchanged, runs against a deployed agent; it survives a container kill and a caller redeploy; and changing one agent deploys that agent alone.

## A3 — TrendBot

- TrendBot's needs met against [REQUIREMENTS.md](REQUIREMENTS.md); anything it still lacks enters that register through the operator rather than as a contract to chase
- Its guardrail semantics as its own hooks, its git lifecycle in the before and after steps, its three agents deployed
- The sync generator exercised on a real consumer across at least one AgentForge release

**Exit:** TrendBot runs on this AgentForge, and the first one is deleted.
