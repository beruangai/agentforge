# Roadmap

Milestones deliver capability a consumer can actually run. Each is proposed through OpenSpec, and the questions it depends on in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md) are settled first — by spike where they turn on platform behavior.

**StrategyFoundry's M0 is its own lowest bar, not this roadmap's target.** A milestone here ends with agents that execute real work reliably, not with a foundation that compiles.

## A0 — Scaffold, blocking decisions, local spikes

- Nx workspace in the grouped layout on current `@aws/nx-plugin` defaults; Bun, Biome, catalog versions
- Read `@aws/nx-plugin`'s `ts#agent` and its sync machinery for what to extend rather than rebuild (§K)
- **Blocking decisions, before any server code:** how the A2A request handler is assembled (§I), and the task-store interface — conditional index insert, fenced write (§A)
- Local spikes: A2A server assembly and client signing (§I), kernel settlement (§E), the task-process protocol with cancellation and group kill (§C, §G), credential provisioning and expiry (§O), deterministic image builds (§D)
- Procedure authoring settled against real procedures, not argument (§N)

**Exit:** every local spike recorded in `docs/research/`, and the questions it answers closed.

## A1 — A working agent, locally

The whole loop, in Docker, for a procedure a consumer would actually ship.

- Task protocol: envelope, identifiers, events, outcome
- Procedures: contracts and hashes, the run with its seed, options, agent contract and marshal, and the before and after steps (D1–D5, D33)
- Kernel: structured input and output throughout, settlement, abort, session start, resume and fork (D3, D9, D17)
- Guardrail hooks composing without loss, and telemetry (D8, D23)
- Runtime: A2A server, gateway and executor, a process per task, filesystem task store behind the fenced interface, generated agent card
- Caller-agnostic client and the Temporal activity factory: start, attach, await with heartbeat, cancel (D10, D13, D14)
- Typed outcomes with their causes, and what every task records (D19, D22)
- Base image, and one package image with an agent over it, built locally; the two state mounts stood in locally; credentials provisioned as §O decides (D17, D29)
- Failure-injection tests for every layer-2 failure in `ARCHITECTURE.md` §9

**Exit:** a StrategyFoundry workflow runs a real directive against a local container, gets validated structured output, and can cancel it, retry it, and resume its session — with the run's seed, options, transcript and usage recorded.

## A2 — The same agent on AgentCore

- AgentCore spikes: busy-container reachability and concurrency (§B), cancellation (§C), task store lease and visibility (§A), session resume across containers on the mounts (§F)
- A2A client over `InvokeAgentRuntime` with SigV4 and 409 retry; durable task store; idempotency, lease and loss; admission limits
- The Nx plugin: generators for an agents project, a package image, an agent, a procedure and a caller's wiring, plus the sync generator (§K)
- CDK constructs and the deploy path: deterministic images, digest comparison, and an update only where the digest moved (§D)
- Failure-injection tests for every layer-1 failure, on AgentCore

**Exit:** the same procedure, unchanged, runs against a deployed agent; it survives a container kill and a caller redeploy; and changing one agent deploys that agent alone.

## A3 — TrendBot

- TrendBot's contract confirmed against the distilled set, and the items in [CONSUMERS.md](CONSUMERS.md)'s "not carried" table settled
- Its guardrail semantics as its own hooks, its git lifecycle in the before and after steps, its three agents deployed
- The sync generator exercised on a real consumer across at least one AgentForge release

**Exit:** TrendBot runs on this AgentForge, and the first one is deleted.
