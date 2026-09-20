# Roadmap

Milestones deliver capability a consumer can use. Each is proposed through OpenSpec, and the questions it depends on in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md) are settled first — by spike where they turn on platform behavior.

## A0 — Scaffold and local spikes

- Nx workspace in the grouped layout on current `@aws/nx-plugin` defaults; Bun, Biome, catalog versions
- Read `@aws/nx-plugin`'s `ts#agent` generator for the conventions worth reusing (§K)
- Toolchain check for procedure authoring: standard decorators on Bun, inference, and decorator metadata (§N)
- Local spikes: kernel settlement (§E), the task-process protocol with cancellation and group kill (§C, §G), session persistence and cross-container resume (§F), A2A server assembly and client behavior (§I)

**Exit:** each local spike recorded in `docs/research/`, and the questions it answers closed.

## A1 — Local slice

What StrategyFoundry's M0 requires, running locally in Docker.

- Task protocol: envelope, identifiers, events, outcome
- Procedure model: contracts, the three steps, the `agent()` helper, additive option contributions, marshalling
- Procedure authoring settled against StrategyFoundry's real procedures (§N)
- Kernel, with structured output validated inside it rather than as an option
- Runtime: A2A server, TaskExecutor, a process per task, filesystem task store, generated agent card
- Caller-agnostic client, and the Temporal activity factory over it
- Base image, and a bundle mounted from a directory
- Failure-injection tests for the layer-2 failures in `ARCHITECTURE.md` §8

**Exit:** a StrategyFoundry workflow calls a procedure through a local link and gets schema-validated structured output back.

## A2 — AgentCore

- AgentCore spikes: busy-session reachability and concurrency (§B), cancellation (§C), task store and lease (§A), bundle mount and reload (§D)
- A2A client over `InvokeAgentRuntime` with SigV4 and 409 retry; durable task store; idempotency and loss detection; cancellation; admission limits
- CDK constructs and the bundle publish command; the mounted bundle, read-only and content-addressed (§D, §K)
- Failure-injection tests for the layer-1 failures, on AgentCore

**Exit:** the same workflow runs against a deployed runtime, unchanged, and survives a container kill.

## A3 — TrendBot

- TrendBot's contract confirmed in a TrendBot session
- Procedures without an agent (§J), the guardrail helpers, and the before and after steps TrendBot's git lifecycle needs
- The requirements marked **migration** met; TrendBot moves off the first AgentForge
