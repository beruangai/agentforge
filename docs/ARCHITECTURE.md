# Architecture

> **Status: working proposal.** Nothing here is accepted. Every [ADR](../adr/README.md) is `proposed` until implementation settles it and the operator accepts it. Requirements this must meet are the consumers', in [CONSUMERS.md](CONSUMERS.md) — themselves unvetted drafts. Open questions are in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md), marked inline as **[OPEN §x]**; code sketches show shape, not signatures.

AgentForge runs a consumer's **procedure** as an asynchronous **task**, in an isolated runtime, and returns a typed outcome to whatever called it. Temporal is the caller both consumers use and is supported first-class through an activity factory, but nothing below the client knows a caller exists.

This document defines the layers, what crosses between them, and the two places where that crossing is a protocol rather than a function call.

---

## 1. Layers

```
  caller — any process; a Temporal activity through the activity factory
        │
        │  client API, typed by the procedure contract
        ▼
┌───────────────────────────────────────────────────────────────┐
│ 1. RUNTIME                                                    │
│    client ── A2A JSON-RPC ──► gateway ──► executor            │
│                                  │           │                │
│                          task store          │                │
└──────────────────────────────────────────────┼────────────────┘
                                               │  task-process protocol
                                               ▼
┌───────────────────────────────────────────────────────────────┐
│ 3. CONSUMER    task entrypoint — resolves the procedure        │
│                the only place layers 1 and 2 meet              │
└──────────────────────────────────────────────┼────────────────┘
                                               ▼
┌───────────────────────────────────────────────────────────────┐
│ 2. HARNESS     procedures, the agent run, the outcome          │
└──────────────────────────────────────────────┼────────────────┘
                                               ▼
                         4. Claude Agent SDK — query()
```

| Layer | Owns | Knows nothing of |
|---|---|---|
| **1. Runtime** | The wire; the gateway (envelope, idempotency, admission) and the executor (spawn, signal, lease); task state; `/ping`; the agent card; the client | Claude, the SDK, what a procedure does, who is calling |
| **2. Harness** | Procedures — contracts, marshalling, side-effect steps; running one Claude query to a settled, typed outcome | A2A, AgentCore, callers, task state, the container |
| **3. Consumer** | Its procedures, its identifiers, its side effects and their recovery; which agents it deploys and what each serves | How 1 and 2 work internally |
| **4. SDK** | The agent loop | — |

**Layers 1 and 2 never import each other.** Each is testable alone: the harness runs a procedure against a fixture with no container and no caller; the runtime runs a task whose process is a stub. They share one library, the **task protocol** — the envelope, the identifiers, the process messages, and the outcome — which depends on Zod alone.

**Delivery — the CDK constructs, the bundle publish command, and later the Nx generators — is tooling, not a layer.** It is how a consumer gets a deployed agent (§6).

### The two protocols, and three interfaces

Only two crossings are protocols: a contract between separately deployed, separately versioned things. Everything else is an interface inside a layer and gets no ceremony.

| Protocol | Between | Contract |
|---|---|---|
| **Wire** | Caller's client ↔ the agent's gateway | A2A JSON-RPC 2.0 over `InvokeAgentRuntime`, SigV4-signed, routed by the session header. `SendMessage` with `returnImmediately` starts or attaches; `GetTask` reads; `CancelTask` stops. The envelope is a data part; the outcome is an artifact ([ADR 0002](../adr/0002-a2a-is-the-boundary-contract.md)) |
| **Task process** | Executor ↔ task process | JSON-RPC 2.0, one message per line, over a dedicated pipe. `run` and `cancel` in; semantic events numbered per task, and exactly one outcome, out; the exit code is the backstop. `SIGTERM` then `SIGKILL` to the process group ([ADR 0004](../adr/0004-a-process-per-task.md)) |

| Interface | Inside | Note |
|---|---|---|
| Client API | Layer 1 | `start`, `await`, `cancel`, typed by the contract the caller imports. Caller-agnostic; the Temporal activity factory sits over it |
| Task store | Layer 1 | A2A's `TaskStore`, extended with an index by idempotency key and a fencing token (§4) |
| Bundle | Deployment | What a task process loads, guarded by the contract hash (§6) |

---

## 2. Identity and isolation

Four identifiers, from three systems. **The consumer decides how they relate; AgentForge carries, propagates and records them, and never imposes a mapping** ([ADR 0007](../adr/0007-identity-is-the-consumers.md)).

| Identifier | System | Isolates or continues | AgentForge's part |
|---|---|---|---|
| `runtimeSessionId` | AgentCore | One microVM: compute, memory, filesystem. At most one container at a time per id **[OPEN §B]** | Routes to it; keeps it stable across attempts |
| `contextId` | A2A | A conversation: related tasks on the wire | Supplied by the client, uuid7 when the caller gives none; returned on every task |
| `sessionId` | Claude Agent SDK | One transcript, started, resumed or forked | Passed to the SDK as the procedure says; recorded |
| Working directory | Claude Agent SDK | The Claude project, which namespaces transcript and memory | Set per procedure |

A fifth, the **idempotency key**, is AgentForge's own: it names one logical execution across its attempts, where a context names a conversation (§4).

**The invariants AgentForge enforces are mechanical, and none interprets a consumer's meaning:**

- **At most one container at a time per runtime session** — the platform's property, not a policy **[OPEN §B]**.
- **One live task per continuity key.** The envelope may carry an opaque **continuity key**; the gateway refuses a second live task under the same one, loudly. A consumer sets it to whatever must not be written twice at once — in practice the Claude session id, because a transcript has one writer. Layer 1 never interprets it.
- **One process per task** (§5).
- **No queueing.** Concurrent tasks are never serialized behind one another (T27). They are bounded instead: a container has 2 vCPU and 8 GB, and an out-of-memory kill takes the whole session with it, so an agent declares an **admission limit**, and a task beyond it is *rejected* rather than queued (§4).

---

## 3. Procedures

A **procedure** is what a consumer declares and AgentForge runs.

### Type-safe end to end

Two halves, in separate modules ([ADR 0003](../adr/0003-procedures-are-type-safe-end-to-end.md)):

- **Contract** — the name, the outer input and output schemas, and a hash. Zod alone, so a caller imports it without the implementation or the Agent SDK.
- **Implementation** — what runs in the container, registered against that contract.

The **outer contract** is what the caller sends and receives; the **agent contract** is what the agent fills in, given to the SDK as its output schema. They differ whenever the outer output carries computed fields the model must not be asked for (T18). The step between them is an ordinary function.

The contract hash travels in the envelope. A container whose loaded bundle does not implement it refuses the task before any work (H3, T3).

### The implementation

Three steps, of which only the middle is required:

| Step | Does | Examples |
|---|---|---|
| **before** | Side effects before the run | Sync a working copy, verify a mount, reconcile after a lost attempt (T33) |
| **run** | Produces the outer output | Usually an agent run; sometimes plain consumer code (T4) |
| **after** | Side effects on success and on failure | Commit and push, record, clean up (T33, T34) |

An agent run is written with the harness's `agent()` helper: the seed, the SDK options, the agent contract, and the function from agent output to outer output. The helper runs the kernel — one `query()` to a settled outcome, with the agent's output validated against its contract before anything else sees it. **Not optional and not middleware** (H7, H8, T15).

A procedure that invokes no agent simply does not call the helper. There is no second kind of procedure: the run step is a function either way.

**Every option a procedure sets reaches the SDK, or the task is rejected** (H4, T7). The options are the SDK's own type rather than a parallel schema, and a test asserts every resolved key reaches `query()` — which is how the first AgentForge's silently-dropped `maxTurns` is prevented. What that cannot prove is that the SDK then *binds* the option; that is **[OPEN §E]**.

### Side effects are the consumer's

**A consumer owns its side effects and how to recover when one may have partly happened.** Every step receives the idempotency key, the attempt number, and the prior attempt's recorded state — none, failed, cancelled, or lost. Because the *after* step runs inside the task process before the outcome leaves it, **`lost` always means side effects may have happened**; a consumer whose source of truth is its own state reconciles against it. AgentForge never infers, retries or compensates a consumer's side effect.

### Reuse

Cross-cutting behavior — guardrail hooks, telemetry, a house style of options — is a function a procedure calls, shipped in a package. Composite options are **additive**: contributions to hooks, MCP servers and denied tools concatenate, and replacing rather than adding is explicit at the call site, so no guardrail is lost to ordering (H5, T8). AgentForge ships a small library (§7); nothing is wired by default.

How a procedure is written — object literal, chained builder, or a class whose methods are its steps — is **[OPEN §N]**, settled by writing StrategyFoundry's real procedures rather than by argument.

---

## 4. Tasks

A **task** is one attempt at one procedure, ending in one **outcome**. It is an A2A task on the wire and an asynchronous job to AgentCore, which keeps `/ping` reporting `HealthyBusy` while it runs.

### Lifecycle

1. **Start.** The caller sends the envelope — procedure name, contract hash, outer input, idempotency key, the identifiers of §2, correlation ids — as an A2A message with `returnImmediately`. The **gateway** handles it before a task id is minted: it validates the envelope, looks up the idempotency key, and either returns the task already running or admits a new one. The **executor** then publishes `submitted` synchronously, before its first `await`, and spawns the task process.
2. **Await.** The caller polls `GetTask` and heartbeats whatever it answers to. **Polling is the default**: streaming is capped at 60 minutes and A2A has no replay across a reconnect, so a run of hours would reconnect repeatedly and recover only the task snapshot. A subscription is for short runs that want progress.
3. **Outcome.** A completed task carries the outer output as its artifact; every failure is a failed task whose artifact carries the typed cause, because A2A has one failed state and a caller needs the reason.
4. **Cancel.** `CancelTask` reaches the gateway, which cancels over the task protocol: the run aborts, flushes telemetry, records `cancelled`, and after a grace period its process group is killed so nothing it started outlives it. A cancel arriving before the process exists is caught by a token the executor sets before its first `await`. **A cancel never falls through to the A2A SDK's default path**, which would mark a task cancelled without consulting the executor — including from a container freshly provisioned to answer it while the original still runs. `StopRuntimeSession` is the blunt fallback and takes every other task in the session with it **[OPEN §C]**.

| Task state | A2A |
|---|---|
| accepted, running | `SUBMITTED`, `WORKING` |
| succeeded | `COMPLETED` + outer output artifact |
| cancelled | `CANCELED` |
| refused before admission — unknown contract hash, continuity conflict, over the admission limit | `REJECTED` + reason |
| every failure, including lost | `FAILED` + typed cause artifact |

### Why the gateway exists

The A2A SDK mints the task id and creates its event bus *before* the executor is reached, and `returnImmediately` resolves on the first event on that bus. An executor therefore cannot answer a request with a different, already-running task — so idempotency, admission and the contract-hash check cannot live in it. They live in a request handler wrapping the SDK's, which inspects the envelope and delegates only once it has decided this is a new task **[OPEN §I]**.

### Task state, the lease, and loss

Task state lives in a store outside the microVM ([ADR 0006](../adr/0006-task-state-is-durable-outside-the-session.md)), so an outcome survives the container, the caller's redeploy, and the connection that asked for it (H10, T24). It is the A2A task store, extended with the idempotency index, the lease and the outcome payload — one record, read through A2A, so a caller needs no store access of its own (T43).

**Writes are fenced.** A2A's `TaskStore.save` overwrites unconditionally, so the store implementation carries a **fencing token** — the lease generation — in the task's metadata and rejects a write from a stale holder. Without it, a container deriving `lost` and the original container finishing `succeeded` are two unordered writes, and whichever lands later wins.

**Loss is derived at read time**, from a lease the executor renews while the task process lives. Nothing sweeps, so **detection latency is the caller's poll interval** — which is what a caller sizes its heartbeat against (H11, T25).

### Idempotency

**The caller supplies the key**, stable across its retries and its own to derive ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)); the Temporal factory derives it from workflow and activity identity. Starting with the same key *is* the idempotency operation — `ListTasks` filters by context and status but not by metadata, so the key is not queryable through the protocol and the store's index carries it. The task id is not the key: A2A mints it, a failed task is terminal, and a new attempt is a new task carrying `referenceTaskIds` to its predecessor, so the chain reads from the protocol alone.

- **Concurrent — guaranteed.** Attempts carry the same runtime session id and reach the same container, whose gateway is that session's single authority; a start whose key names a live task returns that task. The index insert is conditional, so two starts racing cannot both admit.
- **Later — within a retention window** that exceeds the longest retry horizon a consumer configures. Beyond it a repeated request runs again, and `start` reports whether it attached or started, so this is never silent **[OPEN §H]**.

A cancel from one caller ends a task other callers attached to, so the outcome distinguishes who asked: a caller that did not ask should treat it as retryable.

### Outcome

Typed; every failure carries its cause. Layer 1 reads only the kind and its retry guidance — the detail passes through untouched.

| Outcome | Retry guidance |
|---|---|
| `succeeded` | — |
| `output_invalid` — could not conform; payload preserved | Not blindly: a second identical run is not a correction |
| `turn_budget_exhausted` | Consumer's decision |
| `timed_out` — the procedure's own budget | Consumer's decision |
| `deadline_exceeded` — the platform's 8-hour job cap, which no retry beats | No; the procedure must be split |
| `cancelled` — by this caller | No |
| `cancelled_by_another` — a different attached caller asked | Yes, as a new attempt |
| `lost` — the container died; side effects may have happened | Yes, as a new attempt |
| `usage_limited` — with the reset time | Wait until the reset, with jitter: one subscription serves every agent, so tasks hit the limit together |
| `credential_expired` | No; an operator must act |
| `provider_transient` — with the provider's retry-after where it gave one | Yes, after that delay |
| `failed` — harness, SDK or procedure error, with its detail | Consumer's decision |

---

## 5. The container

One server: an A2A server on AgentCore's contract — `0.0.0.0:9000`, JSON-RPC on `POST /`, the card at `/.well-known/agent-card.json`, and `/ping` reporting the container's aggregate status. Whether it is assembled from `@a2a-js/sdk` directly or on the AgentCore SDK's `serveA2A` is **[OPEN §I]**, and it blocks the first slice rather than the first deployment.

**The gateway** decides admission (§4). **The executor** spawns and supervises: one process per task, in its own process group ([ADR 0004](../adr/0004-a-process-per-task.md), measured by **[OPEN §G]**).

- `/ping` shares no event loop with any task, so nothing a task does can stall the health check and get a busy session terminated (T42)
- each task loads the bundle current at its start (§6)
- a crash is contained: the executor records `failed` with the exit code and the tail of stderr, so a task never disappears without a record
- the process speaks the task protocol, and its logs go to the container's log stream

**Credentials.** The operator's subscription token is long-lived and subscription-wide, so it is not placed in the task process's environment where the agent's own shell could read it; the SDK is given a credential helper instead, and an expired credential surfaces as `credential_expired` rather than a generic failure **[OPEN §O]**. AWS credentials cannot be withheld from a child in the same microVM: the task process is *not given* store credentials, but store integrity rests on the microVM boundary, not on a scrubbed environment (T35, T44).

**Guardrails are cooperative.** `writeScope` and `stopGuard` constrain the model's tool use; they are not a sandbox, and a procedure with shell access goes around them.

**Locally**, the same image runs in Docker, the client talks A2A to it directly, task state is on the filesystem behind the same fenced interface, and `docker stop` stands in for the blunt stop. One code path; local is not a mock (H20, T39).

---

## 6. Agents, bundles and delivery

**An agent is the deployable unit**: one AgentCore runtime, one card, one image, the bundle it serves, and its stores — the strongest isolation available. A consumer deploys as many as its strategy wants; TrendBot's three are three agents (T40).

**Agents nest in one project by default** ([ADR 0010](../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)): agents sharing an image differ only by bundle and card, so one project builds one image and holds several agent definitions, each with its own build and deploy target. A separate project is for an agent needing its own image, such as one adding Python and NautilusTrader (H23).

**The bundle is a published artifact** ([ADR 0008](../adr/0008-procedure-code-is-a-published-bundle.md)), **baked into the image by default**. Mounting it instead — so a change reaches the next task without an image rebuild (H22) — is opt-in and carries real cost: the mount forces the runtime into a VPC, a mount failure fails the invocation with the same 424 a container kill produces, and a shared writable mount would let one agent's shell rewrite every agent's code. A mounted bundle is therefore read-only, published content-addressed with a pointer file read once at task start, and never overwritten in place **[OPEN §D]**.

**The agent card is generated at publish time** from the procedures the bundle registers, and baked into the image: a mount is not readable when the platform fetches the card, because a mount exists only during an invocation.

**AgentForge ships the delivery tooling**: CDK constructs for the agent with its A2A configuration, the task store, the bundle and its mount, and `grantInvokeAccess` for a caller's least-privilege role (T43); and the bundle publish command, so deployment and mount cannot drift. Nx generators follow once the first project exists and shows what they should write **[OPEN §K]**.

---

## 7. The harness

### Kernel

One `query()` to a settled outcome, behind the `agent()` helper:

- **Structured output** — the agent contract becomes the SDK's own `outputFormat` (draft-07), and the settled output is validated before anything else sees it. The SDK validates and re-prompts natively now; what beyond that is still needed is **[OPEN §E]**.
- **Settlement** — work the agent dispatches runs in the foreground and completes within the turn that dispatched it, because a turn resumed by background work once cancelled its own final submission (H16, T12, T13). Whether that still holds is **[OPEN §E]**.
- **Abort** — an `AbortSignal` and the SDK's interrupt reach the run; exactly one outcome is published.
- **Session** — started, resumed or forked as the procedure said. How transcripts persist for resume in another container is **[OPEN §F]**; a failed mirror write is surfaced, never swallowed.
- **No blocking** — nothing in the kernel or a helper blocks the event loop.

### Library

Optional functions a procedure calls, each serving a stated requirement:

| Helper | Does |
|---|---|
| `writeScope` | Denies writes outside allowed paths, with allow-union semantics (T9) |
| `stopGuard` | Refuses to end a session while a required artifact is missing (H5, T10) |
| `guardrailDisclosure` | Tells the agent which rules apply, derived from what is enforced (T11) |
| `telemetry` | OpenTelemetry export of the SDK's native telemetry, correlated to the task, flushed before the outcome (H19, T37) |

The guardrail helpers serve TrendBot alone and wait for its contract to be confirmed; their *semantics* may belong in TrendBot's own package, with AgentForge carrying only the hooks (**[OPEN §L]**).

---

## 8. What every task records

Written by AgentForge: the outcome, the attempt and the prior attempt's state, timings, admission and cancel events, every identifier of §2, and any transcript-mirror failure — correlated to the caller's own ids (H18, T38). For an agent run, also the seed as sent, the resolved SDK options, where the transcript is, and usage: tokens, turns, cost (H18, T36).

---

## 9. Failures reproduced as tests

Each failure the first AgentForge paid for ([lineage](lineage/first-agentforge.md)), and each the new boundaries introduce. The last four are new:

| Failure | Layer |
|---|---|
| Caller redeployed mid-run; the result had nowhere to go | 1 |
| Container killed mid-run (AgentCore 424) | 1 |
| A run outlasting the 15-minute synchronous request limit | 1 |
| `/ping` stalled by blocking work on the same event loop | 1 |
| A timed-out attempt left running while its retry started | 1 |
| A resumed turn cancelling the final structured-output call | 2 |
| The result taken before dispatched work settled | 2 |
| Structured output lost to schema conversion | 2 |
| An SDK option accepted and silently dropped | 2 |
| A stale lease holder's write landing after a newer one | 1 |
| A cancelled task leaving subprocesses behind | 1 |
| A second live task admitted under one continuity key | 1 |
| Admission beyond the container's memory, killing its neighbours | 1 |

---

## 10. Repository layout

**By scope, never by type**, in the Nx grouped layout on `@aws/nx-plugin` defaults. Shape, not a commitment.

```
agentforge/
├── adr/  docs/  openspec/
├── apps/
│   └── runtime/
│       └── base-image/        # the image consumers extend
└── libs/
    ├── task/
    │   └── protocol/          # envelope, identifiers, process messages, outcome — Zod only
    ├── runtime/
    │   ├── server/            # A2A server, gateway, executor, card, /ping
    │   ├── client/            # A2A client: AgentCore and local
    │   └── task-store/        # fenced store, idempotency index, lease
    ├── harness/
    │   ├── procedure/         # contracts, implementations, marshalling
    │   ├── agent/             # the agent() helper and the kernel
    │   └── helpers/           # guardrails, telemetry
    ├── infra/
    │   ├── constructs/        # CDK: agent, task store, bundle, caller policy
    │   └── publish/           # the bundle publish command
    └── temporal/
        └── activity/          # activity factory over the client
```

---

## 11. Deliberately absent

- **Any mapping between the four identifiers** — the consumer's, procedure by procedure (§2)
- **Queueing, and any concurrency ceiling that is not about memory** — the caller's (T27)
- **Recovery of a consumer's side effect** — the consumer's (§3)
- **Rate limiting or durability for the tools an agent calls** — a consumer-hosted MCP server owns its limits and whatever backs them
- **Agent discovery and agent-to-agent orchestration** — the card is generated and otherwise unused
- **Agent frameworks other than the Claude Agent SDK** — a procedure's run step is a function; another framework needs no new concept here
- **Synchronous invocation, and any second server in the container**
- **Consumer vocabulary** — no directive, entity, vault, or strategy
