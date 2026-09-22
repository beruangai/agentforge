# Solution Space

## The problem

A project that puts Claude agents behind durable workflows rebuilds the same plumbing every time: invoke an agent in an isolated runtime, wait for a result without losing it, validate structured output, classify failures so a workflow knows what to do, record what happened, and stop a run when asked. None of it is the project's work, and all of it is paid for twice — once to build, and again as intermittent production failures that cost hours to days to trace.

AgentForge is that plumbing, owned in one place and shared. Its consumers are StrategyFoundry and TrendBot.

## What AgentForge is

**A procedure wrapper for the Claude Agent SDK.** A consumer declares a **procedure**: its public contract, the agent's own contract and how one becomes the other, the prompt the agent starts from, its SDK configuration, and the side effects around the run. AgentForge runs it as an asynchronous **task** — on Bedrock AgentCore Runtime, or locally in Docker — and returns a typed, validated outcome to whatever called it.

It is not a pure agent wrapper. The contract a workflow depends on and the contract an agent fills in usually differ, and marshalling between them type-safely is a core concern rather than a consumer's afterthought.

It is not an opinion about how a consumer isolates its work. AgentCore runtime sessions, A2A contexts, Claude sessions and working directories are four different mechanisms; AgentForge carries them and enforces only what is mechanically necessary ([ADR 0007](../adr/0007-identity-is-the-consumers.md)).

## In scope

- Declaring procedures: contracts, marshalling, prompt composition, SDK configuration, side effects before and after the run
- Running a procedure to a settled, validated, typed outcome, with structured input and output throughout
- Optional helpers for concerns more than one consumer shares
- Asynchronous invocation by any caller: start, await, attach on retry, cancel — with a Temporal activity factory over it, first-class but not required
- A2A as the contract between the caller and the runtime
- Task state that outlives the container: idempotency, loss detection, the outcome
- Hosting on Bedrock AgentCore Runtime, and the same path locally in Docker
- A base image consumers extend, layered into their own package and agent images, so a change deploys only what contains it
- Delivery as an Nx plugin on `@aws/nx-plugin` conventions: generators for an agentic project, an agentic base image, an agent, a procedure and a caller's wiring, a sync generator that keeps a consumer current as AgentForge changes, CDK constructs for an agent with its stores, mounts and least-privilege access, and a deploy path that updates only what changed
- Recording what each task saw, did and produced

## Out of scope

- Anything domain-specific — prompts, schemas and context are the consumer's
- Orchestration — the consumer's workflows own sequencing, retries and gating; Temporal is a supported caller, never a dependency of the runtime or the harness
- How a consumer isolates its work, and any mapping between the four identifiers
- The side effects of a consumer's procedures, and their recovery
- A concurrency ceiling — the caller's
- Rate limiting, queueing or durability for the tools an agent calls — a consumer-hosted MCP server owns its limits and whatever backs them, and the agent knows nothing about what is behind the tool
- Agent discovery and agent-to-agent orchestration; the agent card is generated and otherwise unused
- Streaming a run's progress, and blocking sends — polling is the only way to wait until a procedure's latency warrants more
- Model providers other than Anthropic
- Supporting agent frameworks other than the Claude Agent SDK
- **Procedures that invoke no agent** — AgentForge runs agents. A consumer's plain work belongs in the consumer, whatever its reason for wanting it co-located; this is settled and not reopened
- Cloud infrastructure beyond what an agent needs — accounts, networking, secret storage and pipelines are the consumer's. Mounted filesystems and the VPC they require are tabled: state persists through APIs, and a consumer that wants a mount configures it itself. Keeping a credential out of anything AgentForge emits is not ours to skip (D24)
- Multi-tenancy — one operator per deployment
- Public use — no API stability promise beyond what the consumers need

## Assumptions

- Consumers are TypeScript on Bun, orchestrated by Temporal
- Bedrock AgentCore Runtime is the cloud target; Docker is the local one
- Claude authentication is the operator's Claude Max subscription, used as intended
