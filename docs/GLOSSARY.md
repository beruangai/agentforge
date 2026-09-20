# Glossary

Canonical terms. **Borrow before inventing**: the Claude Agent SDK's, AgentCore's, or A2A's term first, then a term here with the same intent, and only then a new one. A term names a thing or a state, not a command. No consumer's vocabulary enters — a StrategyFoundry *directive* and a TrendBot *directive* are both a **procedure**; a *vault* is a working directory.

## Layers

**Runtime** — Layer 1: the wire, the gateway, the executor, task state, and the client. Distinct from a **runtime session** and from a deployed **agent**.

**Harness** — Layer 2: procedures, the agent run, the outcome. Knows nothing of the wire or the container.

**Caller** — Whatever starts a task through the client. A Temporal activity in both consumers, through the activity factory, but the runtime never knows that.

**Client** — The caller-agnostic API over the wire: `start`, `await`, `cancel`, typed by the contract the caller imports.

**Activity factory** — The Temporal adapter over the client: heartbeats while awaiting, and maps cancellation and outcomes to activity terms. First-class, never required.

## Procedures

**Procedure** — What a consumer declares and AgentForge runs: a contract and an implementation.

**Contract** — A procedure's name, outer input and output schemas, and hash. Zod alone, so a caller imports it without the implementation.

**Implementation** — What runs in the container: an optional *before* step, a required *run* step, an optional *after* step.

**Contract hash** — Identifies the contract a task was started against; a container whose bundle does not implement it refuses the task.

**Outer contract** — What a procedure's caller sends and receives.

**Agent contract** — What the agent fills in, given to the SDK as its output schema. Often differs from the outer output; an ordinary function maps one to the other.

**Step** — One part of an implementation: before, run, after. A function, not a framework phase.

**Agent run** — A run step written with the `agent()` helper: seed, SDK options, agent contract, and the map to outer output.

**Kernel** — What that helper runs: one SDK query to a settled, validated, typed outcome.

**Seed** — The messages a Claude session starts from.

**Helper** — A reusable function a procedure calls — guardrails, telemetry. Optional; nothing is wired by default. Contributions to a composite option are additive.

## Tasks

**Task** — One attempt at one procedure, ending in one outcome. An A2A task on the wire; an asynchronous job to AgentCore, which `/ping` reports as busy.

**Envelope** — What starts a task, carried as an A2A data part: procedure name, contract hash, outer input, idempotency key, identifiers, correlation ids.

**Idempotency key** — Supplied by the caller and stable across its retries; the store indexes tasks by it, so starting again with it attaches rather than runs again ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)).

**Continuity key** — An opaque value in the envelope under which only one task may be live at a time. A consumer sets it to whatever must not be written twice at once, usually the Claude session id; layer 1 never interprets it.

**Attempt** — One task under an idempotency key. A new attempt starts only after the previous task failed, was cancelled, or was lost.

**Retention** — How long task state is kept for a later start with the same idempotency key to attach to.

**Gateway** — The runtime server's request handler, in front of the A2A SDK's: validates the envelope, applies idempotency, admission and the contract-hash check, and either returns a running task or admits a new one.

**Executor** — What spawns and supervises a task process, renews the lease, and publishes events and the outcome. Agnostic of what the task runs.

**Task process** — The process spawned for one task, in its own process group, where the consumer's entrypoint runs the procedure through the harness.

**Task protocol** — The contract between executor and task process: the envelope, events, and the outcome. Shared by layers 1 and 2; Zod alone.

**Task store** — Durable state outside the microVM: A2A's task store, extended with the idempotency index, the lease, and the outcome payload.

**Lease** — A timestamp the executor renews while a task process lives. Stale on an unfinished task means the task is lost.

**Fencing token** — The lease generation, carried in the task's metadata, that a store write must match; it keeps a stale holder from overwriting a newer one.

**Admission limit** — The most tasks an agent runs at once in one container. A task beyond it is rejected, never queued.

**Outcome** — A task's typed result: success with the outer output, or a failure carrying its cause.

**Lost** — The outcome of a task whose container died, derived from a stale lease at read time. Its side effects may have happened.

## Agents and delivery

**Agent** (deployed) — One AgentCore runtime: an image, the bundle it serves, its agent card, and its stores. The deployable unit, and the strongest isolation available. Where "the agent" means the Claude agent inside a run, the context says so.

**Agents project** — One project holding an image and the agent definitions that share it, each deployed as its own runtime ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)).

**Bundle** — The published procedures and harness an agent serves, loaded by each task process at its start. Baked into the image by default; mountable where a consumer wants the faster loop.

**Agent card** — The A2A discovery document, generated at publish time from the procedures a bundle registers.

**Base image** — What AgentForge ships for consumers to extend: Bun, the Claude CLI, and the runtime server.

## Identity

**Runtime session** — AgentCore's `runtimeSessionId`: one microVM with its own compute, memory and filesystem. At most one container at a time per id.

**Context** — A2A's `contextId`: a conversation, as a group of related tasks. Always supplied by the client, uuid7 when the caller gives none; the consumer chooses what it groups. Never the idempotency key.

**Session** — The Claude Agent SDK's: one transcript, started, resumed or forked by id. One live writer at a time.

**Working directory** — Where a run happens; it decides the Claude project that namespaces the transcript and memory.

How these relate is the consumer's choice ([ADR 0007](../adr/0007-identity-is-the-consumers.md)).

## Consumers

**Consumer** — A project that declares procedures and states requirements AgentForge must meet: StrategyFoundry, TrendBot.
