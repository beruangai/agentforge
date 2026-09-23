# Roadmap

Milestones deliver capability a consumer can actually run. Each is proposed through OpenSpec, and the questions it depends on in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md) are settled first — by spike where they turn on platform behavior.

**StrategyFoundry's M0 is its own lowest bar, not this roadmap's target.** A milestone here ends with agents that execute real work reliably, not with a foundation that compiles.

## A0 — Scaffold, blocking decisions, local spikes

**The local spikes are done.** What A0 still owes is the workspace itself.

- Nx workspace in the grouped layout on current `@aws/nx-plugin` defaults; Bun, Biome, catalog versions
- Read `@aws/nx-plugin`'s `ts#agent` and its sync machinery for what to extend rather than rebuild (§K)
- **The blocking decisions are made**: the A2A server is assembled rather than inherited ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md), §I), it speaks 1.0 only ([ADR 0014](../adr/0014-agentforge-speaks-a2a-1-0-only.md)), a procedure is an oRPC contract ([ADR 0013](../adr/0013-a-procedure-is-an-orpc-contract.md), §N), and the task store is one task item plus a tiny index item (§A)
- **Landed:** kernel settlement (§E), the task-process protocol with cancellation and group kill (§C, §G), deterministic image builds (§D), the procedure framework (§N), capability composition (§L/§REQ203), and the AgentCore behaviour §A, §B, §C and §I rested on
- **Still owed as a spike:** credential provisioning and expiry (§O)

- **`spikes/` is triaged and removed.** It sits outside the Nx layout and does not survive this milestone: each spike is carried into a capability's `integ/` or deleted, per the disposition already decided in [`spikes/README.md`](../spikes/README.md)

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
- CDK constructs and the deploy path: deterministic images, digest comparison, and an update only where the digest moved (§D)
- Failure-injection tests for every layer-1 failure, on AgentCore

**Exit:** the same procedure, unchanged, runs against a deployed agent; it survives a container kill and a caller redeploy; and changing one agent deploys that agent alone.

## A3 — TrendBot

- TrendBot's needs met against [REQUIREMENTS.md](REQUIREMENTS.md); anything it still lacks enters that register through the operator rather than as a contract to chase
- Its guardrail semantics as its own hooks, its git lifecycle in the before and after steps, its three agents deployed
- The sync generator exercised on a real consumer across at least one AgentForge release

**Exit:** TrendBot runs on this AgentForge, and the first one is deleted.
