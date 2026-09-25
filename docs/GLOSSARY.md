# Glossary

**Borrow before inventing, and never shorten**: the Claude Agent SDK's, AgentCore's or A2A's term first, verbatim — the protocol calls it `GetTask`, so it is `GetTask` — then a term here, and only then a new one. No consumer's vocabulary: a *directive* is a **procedure**, a *vault* is a **working directory**.

## Layers and parts

**Runtime** — Layer 1: the server, gateway, executor, task store and client. Distinct from a **runtime session** and a deployed **agent**.

**Harness** — Layer 2: running a procedure through the kernel to an outcome.

**Caller** — Whatever starts a task through the client; a Temporal activity in both consumers.

**Client** — `createClient(contract, transport)`: `SendMessage` and `GetTask` per procedure, `CancelTask` at the root, typed by the contract the caller imports. **`awaitTask`** polls `GetTask` to a terminal state.

**Transport** — How the client reaches a server: `localTransport(url)` for a container, `agentCoreTransport({ agentRuntimeArn })` for AgentCore.

**Gateway** — The server's request handler in front of the A2A SDK's: session header, idempotency, attempts, admission, continuity.

**Executor** — Spawns and supervises task processes: the lease, the time budget, cancellation, the process-group kill.

**Task process** — The child process running one task: the consumer's **task entry**, calling `runTaskProcess`.

**Kernel** — `context.runAgent`: one SDK `query()` to a settled, typed outcome.

## Procedures

**Procedure** — A contract and its implementation.

**Contract** — An oRPC procedure contract over Zod: the outer input and output, and meta such as `timeBudget`. What a caller imports.

**Contract hash** — A hash of a contract's input and output JSON Schema; a container refuses a task whose hash it does not implement.

**Implementation** — The oRPC handler registered through `implementAgent(contract)`. Ordinary code around one or more agent runs.

**Agent contract** — The Zod schema given to `runAgent` as `output`: what the model fills in. The handler builds the outer output from it.

**Agent run** — One `context.runAgent({ prompt, output, options })`, recorded as a **run record**.

**Task context** — What a handler receives beside its input: the ids, the attempt and prior attempt, metadata, the cancellation signal, `runAgent`.

**Time budget** — How long a task may run; declared with `timeBudget(seconds)` in the contract's meta, overridable per call, enforced by the executor.

## Tasks

**Task** — One attempt at one procedure, ending in one outcome. An A2A task.

**Envelope** — The data part that starts a task: procedure, contract hash, input, idempotency key, and optionally the continuity key, time budget, metadata and tags.

**Task state** — A2A's, verbatim: `TASK_STATE_SUBMITTED`, `_WORKING`, `_COMPLETED`, `_FAILED`, `_CANCELED`, `_REJECTED`.

**Outcome** — How a task ended: the output, a **cause**, cancelled, or rejected with a reason. Carried as the artifact `outcome`.

**Cause** — `{ code, message, suggestedAction, retryable, retryAfter?, payload?, stackTrace? }` on a failed task. Codes are `SCREAMING_SNAKE_CASE`: `OUTPUT_INVALID`, `OUTPUT_TOO_LARGE`, `BUDGET_EXHAUSTED`, `TIMED_OUT`, `LOST`, `USAGE_LIMITED`, `CREDENTIAL_EXPIRED`, `PROVIDER_TRANSIENT`, `EXECUTION_ERROR`.

**Idempotency key** — The caller's name for one logical execution; a start with it attaches to its live or completed task ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)).

**Attempt** — One task under an idempotency key. A new one starts only once the last failed, was cancelled or was lost, and it is told how.

**Continuity key** — Optional and opaque: at most one live task under it per container.

**Admission limit** — The most tasks a container runs at once; beyond it a start is rejected, never queued.

**Lease** — A time the executor keeps pushing forward while a task process lives. Lapsed on an unfinished task, the task is **`LOST`** — derived when read; its side effects may have happened.

## Identity

**Runtime session** — AgentCore's `runtimeSessionId`: one microVM, one container at a time. Required on every call.

**Context** — A2A's `contextId`: a conversation of tasks.

**Session** — The Agent SDK's: one transcript, started or resumed by id.

**`cwd`** — The SDK's working directory, and the capability root: which `.claude/` layers apply.

**Working directory** — Where a run's files live. Persisting it across containers is open (DESIGN_OPTIONS §F).

## Delivery

**Base image** — `agentforge/a2a-claude`, built from the package's `Dockerfile` over the **tarball**: Bun, what the Claude CLI needs, a non-root user, and AgentForge with its runtime peers installed globally, at `/node_modules`.

**Agentic project** — One project holding an **agentic layer** and the agents nested in it; its **agentic base image** is `FROM` the base image and puts the layer at `/agentic` — dependencies, shared modules, MCP servers, skills, `CLAUDE.md`. Each agent's image adds its source at `/agentic/agent`.

**Workspace** — `/mnt/workspace`: what an agent edits, and each run's `cwd` by default. Where it is configured is open (DESIGN_OPTIONS §W).

**Agent** (deployed) — One AgentCore runtime serving one image. Where "the agent" means the Claude agent inside a run, the context says so.

**Entry point** — One of the package's exports: `/contract`, `/client`, `/temporal`, `/agent`, `/server`, `/infra`. `/agent` and `/server` resolve only under the `agentforge-agent` condition.

**Example** — An agent in `examples/`, built and verified exactly as a consumer's would be. AgentForge's dogfood.

## Consumers

**Consumer** — StrategyFoundry or TrendBot.

**Requirement** — A numbered behavior in [REQUIREMENTS.md](REQUIREMENTS.md), cited as `§REQ304`. Distinct from an ADR, which records why, and a DESIGN_OPTIONS section (`§F`), which is still open.
