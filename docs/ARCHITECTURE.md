# Architecture

> **Status: working proposal.** Nothing here is accepted. Every [ADR](../adr/README.md) is `proposed` until implementation settles it and the operator accepts it. Requirements this must meet are the consumers', in [CONSUMERS.md](CONSUMERS.md). Open questions are in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md), marked inline as **[OPEN §x]**; code sketches show shape, not signatures.

AgentForge runs a consumer's **procedure** as an asynchronous **task**, in an isolated runtime, and returns a typed outcome to whatever called it. Temporal is the caller both consumers use, and it is supported first-class through an activity factory — but nothing below the client knows a caller exists. This document defines the layers, the contract at each boundary between them, and the transport that carries it. Everything else is a layer's private concern.

---

## 1. Layers and boundaries

```
  caller — any process; a Temporal activity through the activity factory
        │
        │  B1  client API, typed by the procedure contract
        ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. RUNTIME                                                    │
│    client  ── B2  A2A JSON-RPC ──►  server + TaskExecutor     │
│                                       │                       │
│                             B4  task store (durable)          │
└───────────────────────────────────────┼───────────────────────┘
                                        │  B3  task-process protocol
                                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. CONSUMER    task entrypoint — resolves the procedure        │
│                the only place layers 1 and 2 meet              │
└───────────────────────────────────────┼───────────────────────┘
                                        ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. HARNESS     procedure model, run kinds, middleware          │
└───────────────────────────────────────┼───────────────────────┘
                                        ▼
                         4. Claude Agent SDK — query()
```

| Layer | Owns | Knows nothing of |
|---|---|---|
| **1. Runtime** | The wire; the TaskExecutor — envelope validation, idempotency, spawning and signalling the task process, the lease, writing task state; `/ping`; the agent card; the caller-agnostic client; the Nx generators, constructs and bundle publishing | Claude, the SDK, run kinds, what a procedure does, who is calling |
| **2. Harness** | The procedure model — contracts, phases, run kinds, marshalling, middleware; running one Claude query to a settled outcome | A2A, AgentCore, callers, the task store, the container |
| **3. Consumer** | Its procedures, its context, its identifiers, its side effects and their recovery; which runtimes it deploys and what each serves | How 1 and 2 work internally |
| **4. SDK** | The agent loop | — |

**Layers 1 and 2 never import each other.** Each is testable alone: the harness runs a procedure against a fixture with no container and no caller; the runtime runs a task whose process is a stub. They share one library, the **task protocol** — the envelope, the B3 messages, the identifiers, and the outcome — which depends on Zod alone.

### The five contracts

| | Between | Contract | Transport |
|---|---|---|---|
| **B1** | Caller ↔ client | `start` returns the task, whether it attached to one already running, and the stream cursor to resume from — never taken as an input, so a caller cannot supply a stale one; `await` polls or subscribes from there; `cancel`. Input and output types come from the procedure contract the caller imports. Caller-agnostic; the Temporal activity factory adapts it to heartbeats, cancellation scopes and retry policy | In-process function calls |
| **B2** | Client ↔ runtime server | A2A: `SendMessage` starts a task, `GetTask` reads it, `CancelTask` stops it, `SubscribeToTask` streams it. The envelope is a data part; the outcome is an artifact ([ADR 0002](../adr/0002-a2a-is-the-boundary-contract.md)) | JSON-RPC 2.0 over `InvokeAgentRuntime`, SigV4; direct HTTP locally |
| **B3** | TaskExecutor ↔ task process | `run` carrying the envelope, and `cancel`, go in; semantic events — never raw model bytes — and exactly one outcome come out, each event numbered in sequence and capped in size by the producer, with the executor stamping identity and timestamps that a producer cannot set; the exit code is the backstop ([ADR 0004](../adr/0004-a-process-per-task.md)) | JSON-RPC 2.0, one message per line, over a dedicated pipe; `SIGTERM` then `SIGKILL` to the process group |
| **B4** | Server ↔ task store | A2A `TaskStore` plus an index by idempotency key, a lease, and the outcome payload. One writer: the TaskExecutor ([ADR 0006](../adr/0006-task-state-is-durable-outside-the-session.md)) | AWS SDK to the store; filesystem locally |
| **B5** | Deployment ↔ container | A published **bundle** — procedures and harness — which each task process loads at its start, refusing a contract hash it does not implement ([ADR 0008](../adr/0008-procedure-code-is-a-published-bundle.md)) | S3 Files mount; baked into the image as the alternative |

---

## 2. Identity and isolation

Four identifiers, from three systems, each meaning something different. **The consumer decides how they relate; AgentForge carries them, propagates them, records them, and never imposes a mapping.** StrategyFoundry isolating by strategy or by iteration and TrendBot isolating by entity are the same mechanism configured differently, and a consumer may differ procedure by procedure.

| Identifier | System | What it isolates or continues | AgentForge's part |
|---|---|---|---|
| `runtimeSessionId` | AgentCore | One microVM: compute, memory, filesystem. At most one container per id | Routes the call to it; keeps the id stable across attempts |
| `contextId` | A2A | A conversation: a group of related tasks on the wire | Always supplied by the client, uuid7 when the caller gives none; returned on every task. Consumers usually align it with the Claude session |
| `sessionId` | Claude Agent SDK | One transcript, started, resumed, or forked | Passes the consumer's choice to the SDK; records which was used |
| Working directory | Claude Agent SDK | The Claude project, which namespaces the transcript and memory | Sets it per procedure, as the procedure says |

A fifth identifier, the **idempotency key**, is AgentForge's own and deliberately not one of these: it names one logical execution across its attempts, where a context names a conversation (§4).

**The invariants AgentForge does enforce are mechanical, never policy:**

- **One container per runtime session**, which is the platform's property. It makes that container's TaskExecutor the single authority for every live task in the session — no distributed lock is needed for anything inside one.
- **One writer per Claude session.** A task that would resume a session a live task holds is rejected, loudly. A consumer that wants a branch instead forks the session.
- **One process per task** (§5).
- **No ceiling of its own.** Concurrent tasks in one runtime session are allowed and never queued behind one another (T27). What concurrent tasks do to a shared working directory is the consumer's concern. What the platform does with concurrent invocations to one session is **[OPEN §B]**.

---

## 3. Procedures

A **procedure** is the unit a consumer declares and AgentForge runs: data in code, namespaced by the consumer, not a router or a framework object.

### Type-safe end to end

A procedure is declared in two halves, in separate modules ([ADR 0003](../adr/0003-procedures-are-type-safe-end-to-end.md)):

- **Contract** — the name, the outer input and output schemas, and a hash. Depends on Zod alone, so the worker imports it to call the procedure type-safely without pulling in the implementation or the Agent SDK.
- **Implementation** — everything that runs in the container, registered against that contract.

The **outer contract** is what the caller sends and receives. The **agent contract** is what the agent itself fills in, given to the SDK as its output schema. They differ whenever the outer output carries computed fields the model must not be asked for, identifiers from the input, or a different shape — so a procedure declares both and the **marshal** step between them. Where they are the same, marshalling is the identity.

The contract hash travels in the envelope. A container that does not implement it refuses the task before spawning anything, so version skew between an independently deployed worker and a container fails loudly rather than as a confusing validation error mid-run (H3, T3).

### Run kinds

A procedure's **run kind** decides what its run phase does. Composition, not a subclass: nothing above the procedure changes with it ([ADR 0005](../adr/0005-the-executor-is-agnostic-of-what-a-task-runs.md)).

| Run kind | Run phase | Adds |
|---|---|---|
| **Claude** | The kernel (§6): one SDK query to a settled outcome | Compose, configure, the agent contract, marshal; Claude middleware; Claude failure causes |
| **Mechanical** | Consumer code, given the input and an abort signal | Nothing — procedures that invoke no agent (T4, **[OPEN §J]**) |

The shared interface is deliberately thin — input and an abort signal in, an outcome out — so the Claude kind gives up nothing: content blocks, hooks, tools, permissions, structured output and settlement live in its own interface. Claude is the only agent run kind built.

### Phases

Each phase is a function the procedure may supply, receiving what has been computed so far and returning its **contributions** to it:

| Phase | Run kinds | Decides | Examples |
|---|---|---|---|
| **prepare** | All | Side effects before the run | Sync a working copy, verify mounts, reconcile a prior attempt |
| **compose** | Claude | The seed messages | Fragments, injected memory, the objective, content blocks, cache boundaries |
| **configure** | Claude | The SDK options | Model, tools, permissions, MCP servers, hooks, working directory, session choice, turn budget, timeout |
| **run** | All | — (the kernel, or consumer code) | |
| **marshal** | Claude | Agent output → outer output | Add computed fields, reshape |
| **finalize** | All | Side effects after the run, on success or failure | Commit and push, record, clean up |

#### Contributions, and the check that they survive

A composite option — hooks, MCP servers, denied tools, allowed paths — is built from **contributions, not values**. Each contributor returns what it adds; the framework concatenates. Replacing one rather than adding to it takes an explicit marker, so it is visible in review and lands in the task's record.

This is what H5 and T8 actually require: several sources combining with nothing dropped. Neither a phase that returns a fresh object nor a class that forgets to call its parent satisfies that by convention, so it is checked rather than trusted:

- every contribution carries its source
- when the options resolve, the framework asserts each contribution is present in what goes to the SDK
- one that vanished throws, naming the contributor and the option

**Every option a procedure sets reaches the SDK, or the task is rejected** (H4, T7). Nothing accepted is silently dropped, and nothing contributed is silently lost.

### Side effects are the consumer's

**A consumer owns its side effects and their recovery.** AgentForge runs them at phases and gives every phase the idempotency key, the attempt number, and the **prior attempt's recorded state** — none, failed, cancelled, or lost. *Lost* is the signal that side effects may have happened with no record of them; a consumer whose source of truth is its own state reconciles against it. AgentForge never infers, retries, or compensates a consumer's side effect.

### Middleware

**Middleware** is a reusable bundle of phase contributions, declared by a procedure or by a consumer for a group of them. It runs in declared order, and the procedure's own phase functions run last. Because contributions merge and the merge is checked, ordering cannot cost a guardrail (H5, T8). AgentForge ships a library (§6); none is wired by default. How a procedure is written — object literal, chained builder, or a class whose methods are its phases — is **[OPEN §N]**; the contribution rule holds whichever it is.

```ts
// Illustrative only.
const plan = defineProcedure(planContract, {
  run: claude({
    agentOutput: PlanDecisionSchema,
    middleware: [structuredOutput(), writeScope(['iterations/**'])],
    compose: ({ input }) => [fragment('rnd'), objective(input)],
    configure: ({ defaults, input }) => ({
      ...defaults,
      model: 'opus',
      maxTurns: 40,
      cwd: input.workingDirectory,
      session: { resume: input.sessionId },
    }),
    marshal: ({ agentOutput, input }) => ({ ...agentOutput, loopId: input.loopId }),
  }),
});
```

---

## 4. Tasks

A **task** is one attempt at one procedure, ending in one **outcome**. It is an A2A task on the wire and an asynchronous job to AgentCore, tracked so `/ping` reports `HealthyBusy` while it runs.

### Lifecycle

1. **Start.** The caller sends the envelope — procedure name, contract hash, outer input, idempotency key, the identifiers of §2, correlation ids — as an A2A message with `returnImmediately`. The TaskExecutor validates it, applies idempotency, takes the Claude-session lock, spawns the task process, and returns the task as `submitted`.
2. **Await.** The caller reads the task through A2A until it is terminal, heartbeating whatever it answers to. The store behind the server answers even when the original microVM is gone; a subscription is available where streaming is wanted, bounded by AgentCore's 60-minute connection limit.
3. **Outcome.** A completed task carries the outer output as its artifact. Every failure is a failed task whose artifact carries the typed cause (§ Outcome), because A2A has one failed state and our callers need the reason.
4. **Cancel.** `CancelTask` reaches the TaskExecutor, which cancels over B3: the run aborts, flushes telemetry, and records `cancelled`; after a grace period the process group is killed, so nothing the task started — the Claude CLI, shells, MCP servers — outlives it. `StopRuntimeSession` remains the blunt fallback when the container cannot be reached **[OPEN §C]**.

| Task state | A2A |
|---|---|
| accepted, running | `SUBMITTED`, `WORKING` |
| succeeded | `COMPLETED` + outer output artifact |
| cancelled | `CANCELED` |
| every failure, including lost | `FAILED` + typed cause artifact |

### Durability, lease and loss

Task state lives in a store outside the microVM ([ADR 0006](../adr/0006-task-state-is-durable-outside-the-session.md)), so an outcome survives the container, a caller's redeploy, and the connection that asked for it (H10, T24). The TaskExecutor is its **only writer**; the task process holds no credentials for it. The A2A task store is that store, so a caller reads state through A2A alone and needs no store access of its own (T43).

The TaskExecutor renews a **lease** while the task process lives. A stale lease on an unfinished task means the task is **lost** — reported within the lease interval rather than at the activity's start-to-close timeout (H11, T25). A container that starts in a runtime session and finds a live task recorded there under another container instance knows that container is gone, and records it lost immediately without waiting for the lease. Where the store lives is **[OPEN §A]**.

### Idempotency

**The caller supplies an idempotency key** — stable across its retries of the same logical work, and its own to derive ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)). The Temporal activity factory derives it from workflow and activity identity; another caller may hash a payload or use anything else stable. Starting with the same key *is* the idempotency contract: the caller never looks a task up. `ListTasks` filters by `contextId` and status but not by metadata, so the key is not queryable through the protocol and the store's index carries it.

The **task id is not the key**. A2A mints it — the specification does not support client-provided ids for new tasks — and a failed task is terminal, so a new attempt is a new task. A task id identifies one attempt on the wire, never the execution behind it. A new attempt carries `referenceTaskIds` pointing at the prior attempt's task, so the chain is readable from the protocol without the index.

Two edges, with different guarantees:

- **Concurrent — guaranteed.** Attempts carry the same runtime session id, so they reach the same container, whose TaskExecutor is that session's single authority; a start whose key names a live task returns that task instead of starting a second run (H13, T26).
- **Later — within a retention window.** A start whose key matches a task that is running or succeeded attaches to it and returns its outcome; one whose task failed, was cancelled, or was lost starts a new attempt as a new task. Retention exceeds the longest retry horizon a consumer configures, so every retry is covered; beyond it a repeated request runs again, and `start` says whether it attached or started, so this is never silent. Retention's default is **[OPEN §H]**.

### Outcome

Typed; every failure carries its cause. Generic causes apply to every run kind; a run kind adds its own. Layer 1 reads only the kind and its retry guidance — the detail passes through untouched.

| Outcome | Run kinds | Retry guidance |
|---|---|---|
| `succeeded` | All | — |
| `timed_out` | All | Consumer's decision |
| `cancelled` | All | No |
| `lost` — the container died | All | Yes, as a new attempt |
| `failed` — harness, SDK, or procedure error, with its detail | All | Consumer's decision |
| `output_invalid` — could not conform within the turn budget; payload preserved | Claude | Not blindly; a second identical run is not a correction |
| `turn_budget_exhausted` | Claude | Consumer's decision |
| `usage_limited` — with the reset time | Claude | Wait until the reset |
| `provider_transient` — with the provider's own retry-after where it gave one | Claude | Yes, after that delay |

---

## 5. The runtime

### The container

One server, an A2A server on AgentCore's A2A protocol contract: `0.0.0.0:9000`, JSON-RPC on `POST /`, the agent card at `/.well-known/agent-card.json`, `GET /ping` reporting `Healthy` or `HealthyBusy` for the container as a whole. Whether it is built on the AgentCore TypeScript SDK's `serveA2A`, which wraps an `@a2a-js/sdk` executor and tracks busy status already, is **[OPEN §I]**.

**The agent card is generated** from what this runtime registers: its procedures as skills, with their contract hashes. Nothing discovers it today; it costs nothing and is truthful if anything ever does.

**The TaskExecutor** implements A2A's `AgentExecutor`. There is one, and it never varies by procedure or run kind. It validates the envelope, applies idempotency and the session lock, spawns the task process, renews the lease, forwards cancellation, writes task state, and maps events and the outcome to A2A.

**Each task runs in its own process**, in its own process group ([ADR 0004](../adr/0004-a-process-per-task.md)):

- `/ping` shares no event loop with any task, so nothing a task does can stall the health check and get a busy session terminated (T42)
- each task loads the bundle current at its start, which is what makes a mounted, reloadable bundle work (H22)
- a crash is contained: the TaskExecutor records `failed` with the exit code and the tail of stderr, so a task never disappears without a record
- the process speaks B3 and its logs go to the container's log stream

### An agent is the deployable unit

One AgentCore runtime serves one agent card, and a runtime is the strongest isolation there is — its own microVMs, its own filesystem, its own IAM role. So **an agent is a deployed runtime: an image, the bundle it serves, its card, and its stores.** A consumer deploys as many agents as its isolation strategy wants — TrendBot's three are three runtimes (T40) — and decides which procedures each serves.

**Agents are nested in one project by default** ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). Agents that share an image differ only by their bundle and card, so one project builds one image and holds several agent definitions, each deployed as its own runtime and each with its own build and deploy target. A separate project is for an agent that needs its own image — StrategyFoundry's runtime with Python and NautilusTrader (H23).

**The bundle carries the procedures and the harness** ([ADR 0008](../adr/0008-procedure-code-is-a-published-bundle.md)). Publishing a bundle makes it the next task's code without rebuilding the image (H22); the image stays the slow-moving part — Bun, the Claude CLI, and whatever the consumer adds. A bundle baked into the image remains available for a deployment that wants no mount. Limits of the mount are **[OPEN §D]**.

### AgentForge is consumed as an Nx plugin

Following `@aws/nx-plugin`'s conventions, whose own agent generator is built for Strands and therefore not extensible to another framework ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). It provides:

- **Generators** — an agents project with its image and first agent; an additional agent nested in one; a procedure; the caller's client wiring
- **CDK constructs** — the runtime with its A2A configuration and card, the task store, the bundle bucket and its mount, and `grantInvokeAccess` for a caller's least-privilege role (T43)
- **The bundle publish command**, so deployment and mount cannot drift apart
- **A shared image registry** across a workspace's agents, rather than one per agent

The consumer composes the constructs in its own CDK application and owns everything around them — accounts, networking, secrets, pipelines. The generated client is caller-agnostic; the Temporal activity factory is generated beside it for consumers that use Temporal. Their surface is **[OPEN §K]**.

**Locally**, the same image runs in Docker and the client talks A2A to it directly, with a filesystem task store and `docker stop` as the blunt stop. One code path; local is not a mock (H20, T39).

---

## 6. The harness

### Kernel

The Claude run kind's core: one `query()` to a settled outcome.

- **Settlement** — decides when a result is final. Work the agent dispatches runs in the foreground and completes within the turn that dispatched it, because a turn resumed by background work cancelled its own final structured-output call (T12, T13). Whether that still holds on the current SDK is **[OPEN §E]**.
- **Abort** — an `AbortSignal`, and the SDK's interrupt, reach the run; exactly one outcome is published.
- **Outcome** — extracted from the SDK's result, classified (§4), serialized across B3.
- **Session** — starts, resumes, or forks as the procedure said, under the identifiers of §2. How transcripts persist for resume in another container — the SDK's `SessionStore` adapter or a persistent mount — is **[OPEN §F]**.
- **No blocking** — nothing in the kernel or middleware blocks the event loop.

### Middleware library

Opt-in; each a bundle of phase contributions.

| Middleware | Run kind | Does |
|---|---|---|
| `structuredOutput` | Claude | Converts the agent schema for the SDK; a `PreToolUse` hook rejects a non-conforming submission with a readable error so the agent corrects it in-turn; validates the settled output; recovers a submission the CLI dropped (H7, H8, T15) |
| `writeScope` | Claude | Denies writes outside allowed paths, with allow-union semantics (T9) |
| `stopGuard` | Claude | Refuses to end a session while a required artifact is missing, or a validator fails (T10) |
| `guardrailDisclosure` | Claude | Tells the agent which write-scope and termination rules apply, derived from what is enforced (T11) |
| `telemetry` | Claude | OpenTelemetry export of the SDK's native telemetry, correlated to the task, flushed before the outcome (H19, T37) |
| `transientRetry` | Claude | Retries a transient provider failure, resuming the session |
| `forcedExit` | Claude | A tool the agent calls to end deliberately, with a reason |

Which ship in the first slice is settled in its proposal.

---

## 7. What every task records

Written by AgentForge, no middleware required: the outcome, the attempt and the prior attempt's state, timings, and every identifier of §2, correlated to the caller's own ids (H18, T38). For the Claude run kind, also the seed as sent, the resolved SDK options, where the transcript is, and usage — tokens, turns, cost (T36). A consumer's decisions are only as reconstructible as what the task recorded.

---

## 8. Failures reproduced as tests

Each failure that cost the first AgentForge time ([lineage](lineage/first-agentforge.md)) becomes a failure-injection test in the layer that owns it:

| Failure | Layer |
|---|---|
| Worker redeployed mid-run; the result had nowhere to go | 1 |
| Container killed mid-run (AgentCore 424) | 1 |
| A run outlasting the 15-minute synchronous request limit | 1 |
| `/ping` stalled by blocking work on the same event loop | 1 |
| A timed-out attempt left running while its retry started | 1 |
| A cancelled task leaving subprocesses behind | 1 |
| Two tasks resuming one Claude session | 1 |
| A resumed turn cancelling the final structured-output call | 2 |
| The result taken before dispatched work settled | 2 |
| Structured output lost to schema conversion | 2 |
| An SDK option accepted and silently dropped | 2 |
| A middleware's contribution lost to a later phase or a missed merge | 2 |

---

## 9. Repository layout

**By scope, never by type**, in the Nx grouped layout on `@aws/nx-plugin` defaults. The tree shows shape; projects are settled when proposed.

```
agentforge/
├── adr/  docs/  openspec/
├── apps/
│   └── runtime/
│       └── base-image/        # the image consumers extend
└── libs/
    ├── task/
    │   └── protocol/          # envelope, identifiers, B3 messages, outcome — Zod only
    ├── runtime/
    │   ├── server/            # A2A server, TaskExecutor, card, /ping
    │   ├── client/            # A2A client: AgentCore and local
    │   ├── task-store/        # A2A task store, execution index, lease
    │   └── bundle/            # publishing a bundle; loading one in a task process
    ├── harness/
    │   ├── procedure/         # contracts, definitions, phases, run kinds, middleware composition
    │   ├── claude/            # the Claude run kind: kernel, marshalling, its middleware
    │   └── mechanical/        # the mechanical run kind
    ├── infra/
    │   ├── constructs/        # CDK: runtime, task store, bundle bucket and mount, caller policy
    │   └── plugin/            # Nx generators: agents project, agent, procedure, client wiring
    └── temporal/
        └── activity/          # activity factory over the client: heartbeat, cancellation, retry mapping
```

---

## 10. Deliberately absent

- **Any mapping between the four identifiers** — the consumer's, procedure by procedure (§2)
- **A concurrency ceiling** — the caller's (T27)
- **Rate limiting or durability for the tools an agent calls** — a consumer-hosted MCP server owns its limits and whatever backs them; the agent calls a tool and knows nothing about it
- **Recovery of a consumer's side effect** — the consumer's, in its phases (§3)
- **Agent discovery and agent-to-agent orchestration** — the card is generated and unused until a consumer wants it ([ADR 0002](../adr/0002-a2a-is-the-boundary-contract.md))
- **Agent frameworks other than the Claude Agent SDK** — a run kind would carry one ([ADR 0005](../adr/0005-the-executor-is-agnostic-of-what-a-task-runs.md))
- **Synchronous invocation, and any second server in the container** ([ADR 0002](../adr/0002-a2a-is-the-boundary-contract.md), [ADR 0004](../adr/0004-a-process-per-task.md))
- **Consumer vocabulary** — no directive, entity, vault, or strategy
