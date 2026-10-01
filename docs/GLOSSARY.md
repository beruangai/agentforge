# Glossary

**Borrow before inventing, and never shorten**: the Claude Agent SDK's, AgentCore's or A2A's term first, verbatim — the protocol calls it `GetTask`, so it is `GetTask` — then a term here, and only then a new one. No consumer's vocabulary: a *directive* is a **procedure**, a *vault* is a **filesystem**.

## Layers and parts

**Runtime** — Layer 1: the server, gateway, executor, task store and client. Distinct from a **runtime session** and a deployed **agent**.

**Harness** — Layer 2: running a procedure through the kernel to an outcome.

**Caller** — Whatever starts a task through the client; a Temporal activity in both consumers, run by a **workflow project**'s **worker**.

**Client** — `createClient(contract, transport)`: `SendMessage` and `GetTask` per procedure, `CancelTask` at the root, typed by the contract the caller imports. **`awaitTask`** polls `GetTask` to a terminal state.

**Transport** — How the client reaches a server: `localTransport(url)` for a container at a known address, `localContainerTransport(containerName)` for a local container found by name, `agentCoreTransport({ agentRuntimeArn })` for AgentCore, and `agentCoreTransportsFromRuntimeConfig` for a deployment's agents resolved from its **runtime configuration**.

**Gateway** — The server's request handler in front of the A2A SDK's: session header, idempotency, attempts, admission, continuity.

**Executor** — Spawns and supervises task processes: the lease, the time budget, cancellation, the process-group kill.

**Task process** — The child process running one task: the consumer's **task entry**, calling `runTaskProcess`.

**Kernel** — `context.runAgent`: one SDK `query()` to a settled, typed outcome.

## Procedures

**Procedure** — A contract and its implementation.

**Contract** — An oRPC procedure contract over Zod: the outer input and output, and meta such as `timeBudget`. What a caller imports.

**Contract hash** — A hash of a contract's input and output JSON Schema; a container refuses a task whose hash it does not implement.

**Implementation** — The oRPC handler registered through `implementAgent(contract)`. Ordinary code around any number of agent runs, or none.

**Agent contract** — The Zod schema given to `runAgent` as `output`: what the model fills in. The handler builds the outer output from it.

**Agent run** — One `context.runAgent({ prompt, output, options })`, recorded as a **run record**.

**Answer check** — The kernel's `PreToolUse` hook on an agent run's answer submission: the agent contract and every stop guard, all failures told to the agent at once, in its turn.

**Stop guard** — A check a run declares in `guardrails.stop` that must pass before its answer is accepted; denied, it tells the agent why. Not the SDK's `Stop` hook event, which cannot hold back a submitted answer.

**Utility run** — An agent run a procedure makes for itself rather than for its outcome, such as `distill`'s.

**Distillation** — Documents over a token cap compacted by a utility run into one context block that cites its sources by line.

**Task context** — What a handler receives beside its input: the ids, the attempt and prior attempt, metadata, the cancellation signal, `runAgent`, and the mounted `filesystems` with their merged `filesystemPermissions`.

**Time budget** — How long a task may run; declared with `timeBudget(seconds)` in the contract's meta, overridable per call, enforced by the executor.

## Tasks

**Task** — One attempt at one procedure, ending in one outcome. An A2A task.

**Envelope** — The data part that starts a task: procedure, contract hash, input, idempotency key, and optionally the continuity key, time budget, metadata and tags.

**Task state** — A2A's, verbatim: `TASK_STATE_SUBMITTED`, `_WORKING`, `_COMPLETED`, `_FAILED`, `_CANCELED`, `_REJECTED`.

**Outcome** — How a task ended: the output, a **cause**, cancelled, or rejected with a reason. Carried as the artifact `outcome`.

**Cause** — `{ code, message, suggestedAction, retryable, retryAfter?, payload?, stackTrace? }` on a failed task. Codes are `SCREAMING_SNAKE_CASE`: `OUTPUT_INVALID`, `OUTPUT_TOO_LARGE`, `BUDGET_EXHAUSTED`, `TIMED_OUT`, `LOST`, `USAGE_LIMITED`, `CREDENTIAL_EXPIRED`, `PROVIDER_TRANSIENT`, `FILESYSTEM_UNSYNCED`, `EXECUTION_ERROR`.

**Idempotency key** — The caller's name for one logical execution; a start with it attaches to its live or completed task ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)).

**Attempt** — One task under an idempotency key. A new one starts only once the last failed, was cancelled, was lost or was rejected by the procedure, and it is told how.

**Continuity key** — Optional and opaque: at most one live task under it per container. It names different tasks that must not overlap — usually two turns on one Claude session — never the same task, which is the idempotency key's; a start under a running key is **refused**.

**Refusal** — A start a container cannot run now — stopping, at its admission limit, or running the start's continuity key — answered in-band with when to retry, creating no task and binding no key. Distinct from `TASK_STATE_REJECTED`, a start that can never succeed.

**Admission limit** — The most tasks a container runs at once; beyond it a start is **refused**, never queued.

**Lease** — A time the executor keeps pushing forward while a task process lives. Lapsed on an unfinished task, the task is **`LOST`** — derived when read; its side effects may have happened.

## Identity

**Runtime session** — AgentCore's `runtimeSessionId`: one microVM, one container at a time. Required on every call.

**Context** — A2A's `contextId`: a conversation of tasks.

**Session** — The Agent SDK's: one transcript, started or resumed by id.

**Session store** — The SDK's `SessionStore`: where a run's transcript is mirrored so a session resumes in another container. Deployed, AgentForge's is the agent's **session bucket**, an S3 bucket the construct provisions and names in `AGENTFORGE_SESSION_BUCKET`; a procedure may name its own.

**`cwd`** — The SDK's working directory, and the capability root: which `.claude/` layers apply.

**Working directory** — The SDK's name for `cwd`, as §REQ401 uses it. The files a procedure works on are its **filesystems**, not its working directory.

**Filesystem** — Files AgentForge manages for a procedure, persistent or scratch: a kind (`S3Filesystem`, `ScratchFilesystem`, or a consumer's subclass) registered by name with the `filesystems()` middleware, mounted before the handler and unmounted once the outcome is known. To **mount** one is to pull its store into a local directory — not a runtime or container mount. Its operations are **pull** and **push**; `pushOn` lists the task states it pushes on — `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, or both; never a cancel or a timeout, and absent it never pushes. A **checkpoint** is a push, while the task runs, of what has settled. Its **scope** — the `remotePath` mounted and the `read` and `write` globs within it — is resolved per request; the handler receives its `localPath` and **baseline permissions** and decides what an agent gets ([ADR 0015](../adr/0015-filesystems-mount-around-a-procedure.md)).

## Delivery

**Container workspace** — `/workspace` in every image: a Bun workspace whose members are the layers — `agentforge`, `agentic`, `agentic/agent` — each installed by the image that adds it, from a lock of the whole workspace up to it.

**AgentForge image** — `agentforge/a2a-claude:<version>`, built from the package's `Dockerfile` over the bundle: Bun, what the Claude CLI needs, a non-root user, and the container workspace with AgentForge and its runtime peers.

**Agentic project** — An Nx project the plugin generates: a **base layer** and the agents built on it, recorded as **agent components**, with its **project client** and **project construct**.

**Base layer** — An agentic project's shared layer: the member at `/workspace/agentic`, named `@<scope>/<project>-base` — dependencies, shared modules, MCP servers, and a `.claude/` with skills and `CLAUDE.md` that every agent's session composes.

**Agentic image** — `<scope>/<project>:local`: the base layer on the AgentForge image.

**Agent image** — `<scope>/<project>-<agent>:local`: an agent's layer — the member at `/workspace/agentic/agent`, its cwd — on the agentic image.

**Agent component** — An agent's record in its project's `metadata.components`: its name, runtime-configuration key (`<Project><Agent>`) and container name (`<scope>-<project>-<agent>`). Every artifact spanning the project's agents is rendered from these.

**Runtime configuration** — `@aws/nx-plugin`'s `RuntimeConfig`: a stage's AppConfig application, where each agent's construct registers its ARN under namespace `agentcore`, `agentRuntimes.<key>`.

**Project client** — An agentic project's `client.ts`: one client over its agents, typed by their contracts, built with `withTransports`, `local()` or `fromRuntimeConfig`.

**Project construct** — The CDK construct wrapping an agentic project's agent constructs; its `grantInvoke` grants a caller exactly those agents and the runtime configuration's read.

**Workflow project** — An Nx project the plugin generates as a Temporal caller: its workflows, its own activities and one **worker**, calling the agents of each agentic project it has a **connection** to.

**Connection** — A component in a workflow project's `metadata.components` recording an agentic project it calls (`name`, `path`, `packageName`, `key`); every artifact spanning the connections is rendered from them.

**Worker** — A workflow project's Temporal worker: `worker.ts` over `runWorker`, on Node, polling the task queue `<scope>-<project>`; locally `serve`, deployed a `TemporalWorker` on ECS polling Temporal Cloud.

**Local Temporal server** — The docker-compose Temporal server every project on the machine shares, which the `temporal-server` executor starts and registers a project's namespace on.

**Required secrets** — The secrets an agent must be given, by the environment variable each becomes: AgentForge's own (`CLAUDE_CODE_OAUTH_TOKEN`), then `REQUIRED_SECRETS` in the base layer's `secrets.ts` and in the agent's. The agent's construct requires exactly these in `secrets`, `serve` passes each by name, and the server fails a request while one is unset.

**Maintained** — A generated file, key or target that `nx sync` keeps to what the installed AgentForge renders.

**Scaffolded** — Written by a generator once, when absent, and never touched again.

**Detached** — A maintained file or target named in the project's `metadata.agentforge.detached`: sync leaves it alone, and its updates are the consumer's.

**Agent** (deployed) — One AgentCore runtime serving one image. Where "the agent" means the Claude agent inside a run, the context says so.

**Entry point** — One of the package's exports: `/contract`, `/client`, `/temporal`, `/temporal/workflow`, `/agent`, `/server`, `/infra`. `/agent` and `/server` resolve only under the `agentforge-agent` condition.

**Example** — An agentic project in `packages/examples/`, generated by the plugin and verified exactly as a consumer's would be. AgentForge's dogfood: `golden-kata`, a realistic project, `golden-kata-workflows`, a workflow project connected to it, and `smoke-coverage`, what AgentForge does around a run.

## Consumers

**Consumer** — StrategyFoundry or TrendBot.

**Requirement** — A numbered behavior in [REQUIREMENTS.md](REQUIREMENTS.md), cited as `§REQ304`. Distinct from an ADR, which records why, and an open design option in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md) (`§ODO003`), which is still open.
