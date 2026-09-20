# Glossary

Canonical terms. **Borrow before inventing**: the Claude Agent SDK's, AgentCore's, or A2A's term first, then a term here with the same intent, and only then a new one. A term names a thing or a state, not a command. No consumer's vocabulary enters — a StrategyFoundry *directive* and a TrendBot *directive* are both a **procedure**; a *vault* is a working directory.

## Procedures

**Procedure** — The unit a consumer declares and AgentForge runs: a contract, an implementation, a run kind, and the phases between them.

**Contract** — A procedure's name, outer input and output schemas, and hash. Depends on Zod alone, so a worker imports it without the implementation.

**Implementation** — The half of a procedure that runs in the container, registered against its contract.

**Contract hash** — Identifies the contract a task was started against; a container that does not implement it refuses the task.

**Outer contract** — What a procedure's caller sends and receives.

**Agent contract** — What the agent itself fills in, given to the SDK as its output schema. Often differs from the outer output.

**Marshal** — The phase turning agent output, with the outer input and run metadata, into outer output.

**Run kind** — What a procedure's run phase does: *Claude*, the kernel running one SDK query; or *mechanical*, consumer code. Nothing above the procedure depends on which.

**Phase** — One step of a task, receiving the defaults so far and returning what to keep, extend or override. Prepare, run and finalize belong to every run kind; compose, configure and marshal to the Claude kind.

**Seed** — The messages a Claude session starts from, produced by the compose phase.

**Middleware** — A reusable bundle of phase contributions. Opt-in; never wired by default.

**Kernel** — The Claude run kind's core: one SDK query to a settled, typed outcome.

## Tasks

**Task** — One attempt at one procedure, ending in one outcome. An A2A task on the wire; an asynchronous job to AgentCore, which `/ping` reports as busy.

**Envelope** — What starts a task, carried as an A2A data part: procedure name, contract hash, outer input, idempotency key, identifiers, correlation ids.

**Idempotency key** — Supplied by the caller and stable across its retries of the same logical work; the server indexes tasks by it, so starting again with it attaches rather than runs again ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)). The Temporal activity factory derives it from workflow and activity identity.

**Attempt** — One task under an idempotency key. A new attempt starts only after the previous task failed, was cancelled, or was lost.

**Retention** — How long task state is kept for a later start with the same idempotency key to attach to.

**TaskExecutor** — The runtime server's implementation of A2A's `AgentExecutor`. One per container, agnostic of run kind: validates the envelope, applies idempotency and the session lock, spawns and signals the task process, renews the lease, and is the only writer of task state.

**Task process** — The process a TaskExecutor spawns for one task, in its own process group, where the consumer's entrypoint runs the procedure through the harness.

**Task protocol** — The contract between TaskExecutor and task process: the envelope, events, and the outcome. Shared by layers 1 and 2; depends on Zod alone.

**Task store** — Durable state outside the microVM: the A2A task store, plus the index by idempotency key, the lease, the container instance, and the outcome payload.

**Lease** — A timestamp the TaskExecutor renews while a task process lives. Stale on an unfinished task means the task is lost.

**Outcome** — A task's typed result: success with the outer output, or a failure carrying its cause. Generic causes apply to every run kind; a run kind adds its own.

**Lost** — The outcome of a task whose container died, from a stale lease or from a later container in the same runtime session.

## Runtime and deployment

**Agent** — A deployed AgentCore runtime: an image, the bundle it serves, its agent card, and its stores. The strongest isolation available, and the unit a consumer deploys.

**Agents project** — One project holding an image and the agent definitions that share it, each deployed as its own runtime ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)).

**Bundle** — The published procedures and harness a runtime serves, loaded by each task process at its start.

**Base image** — What AgentForge ships for consumers to extend: Bun, the Claude CLI, and the runtime server.

**Client** — The caller-agnostic API over A2A: start, await, cancel, typed by the procedure contract the caller imports.

**Activity factory** — The Temporal adapter over the client: heartbeats while awaiting, maps cancellation and outcomes to activity terms. First-class, never required.

## Identity

**Runtime session** — AgentCore's `runtimeSessionId`: one microVM with its own compute, memory and filesystem. At most one container per id.

**Context** — A2A's `contextId`: a conversation, as a group of related tasks. Always supplied by the client, uuid7 when the caller gives none; the consumer chooses what it groups, and usually aligns it with the Claude session. Never the idempotency key ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)).

**Session** — The Claude Agent SDK's: one transcript, started, resumed or forked by id. One live writer at a time.

**Working directory** — Where a procedure's run happens; it decides the Claude project that namespaces the transcript and memory.

How these relate is the consumer's choice ([ADR 0007](../adr/0007-identity-is-the-consumers.md)).

## Consumers

**Consumer** — A project that declares procedures and states requirements AgentForge must meet: StrategyFoundry, TrendBot.
