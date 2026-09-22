# Architecture

> **Status.** The decisions this rests on are [accepted ADRs](../adr/README.md). **Until code exists, an accepted ADR is mutated in place when its reasoning stops holding** — the operator's standing rule, because there is nothing built on it to migrate. A superseding ADR is for after that. Either way the decision is the operator's to make. What is still undecided is in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md), marked inline as **[OPEN §x]**. Requirements are in [REQUIREMENTS.md](REQUIREMENTS.md), which is AgentForge's own register. Code sketches show shape, not signatures; there is no implementation yet.

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

**Delivery — the Nx plugin, its generators, the CDK constructs and the build-and-deploy path — is tooling, not a layer.** It is how a consumer gets a deployed agent and stays in step with AgentForge as it changes (§6).

### The two protocols, and three interfaces

Only two crossings are protocols: a contract between separately deployed, separately versioned things. Everything else is an interface inside a layer and gets no ceremony.

| Protocol | Between | Contract |
|---|---|---|
| **Wire** | Caller's client ↔ the agent's gateway | A2A **1.0 only** over `InvokeAgentRuntime`, SigV4-signed, routed by the session header ([ADR 0014](../adr/0014-agentforge-speaks-a2a-1-0-only.md)). `SendMessage` with `returnImmediately` starts or attaches; `GetTask` polls; `CancelTask` stops — the protobuf RPC names 1.0 uses. Streaming and blocking sends are unused until a procedure needs them. The envelope is a data part; the outcome is an artifact ([ADR 0002](../adr/0002-a2a-is-the-boundary-contract.md)) |
| **Task process** | Executor ↔ task process | JSON-RPC 2.0, one message per line, over a dedicated pipe, opening with a **protocol version** both sides must accept. `run` and `cancel` in; semantic events numbered per task, and exactly one outcome, out; the exit code is the backstop. `SIGTERM` then `SIGKILL` to the process group ([ADR 0004](../adr/0004-a-process-per-task.md)) |

| Interface | Inside | Note |
|---|---|---|
| Client API | Layer 1 | `SendMessage` and `GetTask` per procedure and `CancelTask` at the root, derived from the contract the caller imports, plus an `await` helper that polls `GetTask` to a terminal state. Caller-agnostic; the Temporal activity factory sits over it |
| Task store | Layer 1 | A2A's `TaskStore`, extended with an index by idempotency key and a fencing token (§4) |
| Image | Deployment | What a task process runs, guarded by the contract hash (§6) |

---

## 2. Identity and isolation

Four identifiers, from three systems. **The consumer decides how they relate; AgentForge carries, propagates and records them, and never imposes a mapping** ([ADR 0007](../adr/0007-identity-is-the-consumers.md)).

| Identifier | System | Isolates or continues | AgentForge's part |
|---|---|---|---|
| `runtimeSessionId` | AgentCore | One microVM: compute, memory, filesystem. **One container per id, measured** — six new session ids took six distinct containers and 6/6 stayed pinned on a later round | Routes to it; keeps it stable across attempts |
| `contextId` | A2A | A conversation: related tasks on the wire | Supplied by the client, uuid7 when the caller gives none; returned on every task |
| `sessionId` | Claude Agent SDK | One transcript, started, resumed or forked | Passed to the SDK as the procedure says; recorded |
| `cwd` | Claude Agent SDK | The **capability root** — which `.claude/` layers apply, and therefore what the agent is | Set per procedure; never the data directory |
| Working directory | Claude Agent SDK | Where a run's files live. Reached through additional directories and explicit permissions | Set per procedure; persisted by sync (§6) |

A fifth, the **idempotency key**, is AgentForge's own: it names one logical execution across its attempts, where a context names a conversation (§4).

**The invariants AgentForge enforces are mechanical, and none interprets a consumer's meaning:**

- **At most one container at a time per runtime session** — the platform's property, not a policy. Measured: six new session ids took six distinct containers, and a second round returned the same six, 6/6 ([research](research/agentcore-runtime-observed.md)).
- **One live task per continuity key.** The envelope may carry an opaque **continuity key**; the gateway refuses a second live task under the same one, loudly. A consumer sets it to whatever must not be written twice at once — in practice the Claude session id, because a transcript has one writer. Layer 1 never interprets it.
- **One process per task** (§5).
- **No queueing.** Concurrent tasks are never serialized behind one another (D15). They are bounded instead: a container has 2 vCPU and 8 GB, and an out-of-memory kill takes the whole session with it, so an agent declares an **admission limit**, and a task beyond it is *rejected* rather than queued (§4).

---

## 3. Procedures

A **procedure** is what a consumer declares and AgentForge runs.

### Type-safe end to end

Two halves, in separate modules ([ADR 0003](../adr/0003-procedures-are-type-safe-end-to-end.md)):

- **Contract** — the name, the outer input and output schemas, and a hash. An oRPC contract over Zod, so a caller imports it without the implementation or the Agent SDK.
- **Implementation** — what runs in the container, registered against that contract.

**One contract, three calls, named as A2A names them.** Invocation is asynchronous, so a consumer declares one contract and a utility derives what a caller actually calls. **The verbs are A2A's own, verbatim** — the wire is A2A, so a translation layer over terms that already exist would be ambiguity bought with nothing:

| Derived | Where | Takes | Returns |
|---|---|---|---|
| `SendMessage` | per procedure | the declared input | a **task handle** — `taskId`, `contextId`, `SUBMITTED`; the same shape for every procedure |
| `GetTask` | per procedure | a task id | a **discriminated union on the task's state**: nothing while `SUBMITTED` or `WORKING`, the declared output on `SUCCEEDED`, the typed cause on a failure (§4) |
| `CancelTask` | **once, at the root** | a task id | the resulting state |

**`GetTask` is one call, not two.** A caller polling a task needs its non-terminal state as much as its outcome, and `GetTask` answers both: it takes `{ id, historyLength? }` and returns the whole task, with **no way to ask for it without its artifacts**. A separate `outcome` call would be a second name over the same wire call returning identical bytes. The union is what makes it typed — a caller reaches the output only inside the `SUCCEEDED` branch, and the compiler refuses it anywhere else.

**`CancelTask` is not derived per procedure, because nothing about it is the procedure's.** It needs a task id and a runtime session id to reach the right container; both are the caller's ([ADR 0007](../adr/0007-identity-is-the-consumers.md)) and neither comes from a contract, so a per-procedure copy would be one signature repeated once per procedure. It sits at the router's root, and it is a separate invocation carrying the id `SendMessage` returned — nothing is held open between them.

**Naming.** Leaf procedures are **PascalCase**, because they are the protocol's own names; namespaces are **camelCase**. So `reviewStrategy.SendMessage`, `reviewStrategy.GetTask`, and `CancelTask` at the root.

### What a caller must supply per call

Two values ride beside the input, in the client's **call context**, and neither is any procedure's to declare ([research](research/procedure-framework.md)):

| | Required on | Why it is not input |
|---|---|---|
| `runtimeSessionId` | **every** call | Transport routing — it becomes the AgentCore session header that reaches the right container |
| `idempotencyKey` | **`SendMessage` only** | Only a start is idempotent. Demanding one on a poll or a cancel would make a caller invent a value that means nothing (§4) |

`ContractRouterClient` applies one context to a whole router, so **AgentForge applies it per call instead**, in the client type it vends. That type is what enforces the difference, which is why a consumer never writes it.

The **outer contract** is what the caller sends and receives; the **agent contract** is what the agent fills in, given to the SDK as its output schema. They differ whenever the outer output carries computed fields the model must not be asked for (D2). The step between them is an ordinary function.

The contract hash travels in the envelope. A container whose image does not implement it refuses the task before any work (D4).

### The implementation

**A procedure is an agent run, with side effects around it.** AgentForge runs agents; work that invokes no agent belongs in the consumer, not here.

| Part | Does | Examples |
|---|---|---|
| **before** | Optional side effects before the run | Sync a working copy, verify a mount, reconcile after a lost attempt (D33) |
| **the run** | The prompt, the SDK options, the agent contract, and the function from agent output to outer output | |
| **after** | Optional side effects on success and on failure | Commit and push, record, clean up (D33) |

**Input and output are structured, always.** The outer input is validated against the contract before the run starts; the agent's output is validated against the agent contract before anything else sees it; the outer output is validated before it leaves. There is no unstructured path and no opt-in — a prose answer is not a contract (D3).

**A task has exactly one time budget.** The procedure declares it; the envelope may override it per invocation, which is how a caller that sizes budgets per call rather than per declaration gets what it needs. The task enforces it and reports `TIMED_OUT`. A caller's own deadline — an activity's start-to-close, say — can only *cancel*; it is never a second authority on when a run ends, and the client reports the budget in force so a caller can size its deadline above it (D6).

**Every option a procedure sets reaches the SDK, or the task is rejected** (D5). The options are the SDK's own type rather than a parallel schema, and a test asserts every resolved key reaches `query()` — which is how the predecessor harness's silently-dropped `maxTurns` is prevented. This is load-bearing rather than belt-and-braces: **the SDK silently ignores an option key it does not know**, so nothing but AgentForge's own validation rejects a typo. The options that were checked do bind — `maxTurns`, `maxBudgetUsd`, `model`, `disallowedTools`, `cwd`, `systemPrompt` and `settingSources` each have an observed consequence ([research](research/kernel-settlement.md)).

### Side effects are the consumer's

**A consumer owns its side effects and how to recover when one may have partly happened.** Every step receives the idempotency key, the attempt number, and the prior attempt's recorded state — none, `FAILED`, `CANCELLED`, or `LOST`. Because the *after* step runs inside the task process before the outcome leaves it, **`LOST` always means side effects may have happened**; a consumer whose source of truth is its own state reconciles against it. AgentForge never infers, retries or compensates a consumer's side effect.

### How one is written

**A procedure is an oRPC contract** ([ADR 0013](../adr/0013-a-procedure-is-an-orpc-contract.md)). A consumer declares the contract; a utility derives the typed calls above; an implementation registers against it.

**A procedure never names its transport.** The same declaration executes in-process in the container and travels over a custom client link from a caller ([research](research/procedure-framework.md)). Two things are the link's to do rather than the framework's:

- **A caller's cancellation is mapped, never dropped.** A signal reaches middleware and the handler, and a handler that races its work against it returns promptly — but a signal cannot travel with an `InvokeAgentRuntime` call, so the link turns a caller's abort into the out-of-band `CancelTask` invocation. Accepting a signal and ignoring it would be a silent failure.
- **A stream's wire encoding is ours.** oRPC's event iterator carries event *objects*; the SSE encoding lives in its HTTP handler, which AgentForge does not use. A streaming link serialises each event itself and must throw on a body that ends mid-frame rather than dropping the tail. Nothing streams today (§4); this is what it would cost.

### Reuse

Cross-cutting behavior — guardrail hooks, telemetry, a house style of options — is shared rather than repeated. It takes one of two shapes, and which one is not a matter of taste:

- **Middleware, where the behavior wraps the run or needs to contribute something.** A house middleware resolves a value and adds it to the **execution context**; every later middleware and the handler see it *typed*, without the procedure having declared it. This is what an object literal could not express and the reason for adopting a framework rather than building one.
- **A plain function, where the behavior only produces a value.** `writeScope` and `stopGuard` contribute SDK options and hooks; they compute a contribution and the procedure composes it.

**Composite contributions are additive**, whichever shape produced them: hooks, MCP servers and denied tools concatenate, and replacing rather than adding is explicit at the call site, so no guardrail is lost to ordering (D8). The hazard this guards against is measured rather than assumed — under `tsc --strict` a class's `override guardrails()` silently drops the house contribution with the compiler's blessing ([research](research/procedure-authoring.md)). AgentForge ships a small library (§7); nothing is wired by default.

---

## 4. Tasks

A **task** is one attempt at one procedure, ending in one **outcome**. It is an A2A task on the wire and an asynchronous job to AgentCore.

**`/ping` manages the session's lifecycle; it does not gate delivery.** `HealthyBusy` means work is in progress, so the session is kept alive and must not be reaped; `Healthy` means idle, and fifteen minutes of it ends the session. Neither status stops an invocation arriving — a container can receive a start, a poll or a cancel whatever it last reported. **Measured on 2026-09-22**: with a 25-second task live and `/ping` answering `HealthyBusy`, a second start, a poll and a cancel were all delivered, 3/3, at idle latency, and the two tasks ran concurrently in one container ([research](research/agentcore-runtime-observed.md)). So the policy is simply: `HealthyBusy` while any task is running, `Healthy` when none is. **Concurrency is the server's own business**, enforced by the gateway's admission limit and answered with a refusal, never signalled through `/ping`. The A2A SDK does no busy tracking of its own — its handler defaults to `Healthy` — so this is ours to implement, where the HTTP path tracks it automatically because it serves one task at a time.

### Lifecycle

1. **Start.** The caller sends the envelope — procedure name, contract hash, outer input, idempotency key, the identifiers of §2, correlation ids — as an A2A message with `returnImmediately`. The **gateway** handles it before a task id is minted: it validates the envelope, looks up the idempotency key, and either returns the task already running or admits a new one. The **executor** then publishes `submitted` synchronously, before its first `await`, and spawns the task process.
2. **Await.** The caller polls `GetTask` and heartbeats whatever it answers to. **Polling is the only supported way to wait.** Streaming is capped at 60 minutes and A2A has no replay across a reconnect, and both consumers are long-running workflow steps where latency is not a concern. A subscription, and a blocking send, are added if a procedure ever appears whose latency warrants them — not before.
3. **Outcome.** A completed task carries the outer output as its artifact; every failure is a failed task whose artifact carries the typed cause, because A2A has one failed state and a caller needs the reason.
4. **Cancel.** `CancelTask` reaches the gateway, which cancels over the task protocol: the run aborts, flushes telemetry, records `CANCELLED`, and after a grace period its process group is killed so nothing it started outlives it. A cancel arriving before the process exists is caught by a token the executor sets before its first `await`. **A cancel never falls through to the A2A SDK's default path**, which would mark a task cancelled without consulting the executor — including from a container freshly provisioned to answer it while the original still runs. `StopRuntimeSession` is the blunt fallback and takes every other task in the session with it. **It is blunter than it looks, and the difference is a budget.** Measured on 2026-09-22: the call returns in ~390 ms, the container gets a real `SIGTERM` ~400 ms later, and it is killed **about 60 seconds after that whatever it is doing** — being busy does not extend the window, and finishing early does not release it. The next invocation on that session id lands on a **fresh container with an empty task store**, so the stopped task is unreachable the moment the stop returns. Anything whose recovery cannot finish inside ~60 seconds must not be attempted in the container ([research](research/agentcore-runtime-observed.md)).

| Task state | A2A |
|---|---|
| `ACCEPTED`, `RUNNING` | `SUBMITTED`, `WORKING` |
| `SUCCEEDED` | `COMPLETED` + outer output artifact |
| `CANCELLED` | `CANCELED` |
| `REFUSED` — unknown contract hash, continuity conflict, over the admission limit | `REJECTED` + reason |
| every failure, including `LOST` | `FAILED` + typed cause artifact |

### Why the gateway exists

The A2A SDK mints the task id and creates its event bus *before* the executor is reached, and `returnImmediately` resolves on the first event on that bus. An executor therefore cannot answer a request with a different, already-running task — so idempotency, admission and the contract-hash check cannot live in it. They live in a request handler wrapping the SDK's, which inspects the envelope and delegates only once it has decided this is a new task. Confirmed working: a duplicate idempotency key returned the already-running task with the executor started **once**, and a `submitted` event published synchronously made `returnImmediately` resolve in **8 ms** against a 6 000 ms run — while withholding that publish made it block for exactly the deferral ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md), [research](research/a2a-server-assembly.md)).

### Task state, the lease, and loss

Task state lives in a store outside the microVM ([ADR 0006](../adr/0006-task-state-is-durable-outside-the-session.md)), so an outcome survives the container, the caller's redeploy, and the connection that asked for it (D11). It is the A2A task store, extended with the lease and the outcome payload — **one task item**, read through A2A, so a caller needs no store access of its own (D32). The **idempotency index is a second, tiny item** keyed by the idempotency key and holding only a pointer, because one item cannot be keyed two ways and a GSI is eventually consistent and so cannot back a conditional insert. A poll reads the task item alone: one `GetItem`, 1 RCU under 4 KB.

**A container names itself.** Each container process mints a **uuid7 at start** and writes it with the lease, so a later container serving the same runtime session sees a different id and declares the task lost *immediately* rather than waiting out the lease. The runtime session id cannot do this job — it is stable across container replacement, which is exactly the case being detected.

**DynamoDB holds it**: conditional writes give attach-or-start atomically and lease renewal is a cheap update.

**An outcome is capped at 256 KB, and a larger one fails.** Not offloaded to S3 — failed, with `OUTPUT_TOO_LARGE`, after a warning in the record at half that. The cap sits under DynamoDB's 400 KB item limit with room for the rest of the record, and at a size every other AWS transport a caller might put it through will also accept.

Offloading instead would push the cost outward: a caller orchestrating on the outcome would have to fetch it, and since AgentForge cannot tell which field the workflow actually needs, the *whole* outcome would go to S3 and every read would pay for it. An outcome is status, identifiers and references; a procedure producing long-form work writes it to the working directory and returns where it is. A procedure that cannot fit 256 KB of actionable state is telling you its agent contract is wrong, and failing in development is where that should surface. Remaining store details are **[OPEN §A]**.

**Writes are fenced.** A2A's `TaskStore.save` overwrites unconditionally, so the store implementation carries a **fencing token** — the lease generation — in the task's metadata and rejects a write from a stale holder. Without it, a container deriving `lost` and the original container finishing `succeeded` are two unordered writes, and whichever lands later wins.

**Loss is derived at read time**, from a lease the executor renews while the task process lives. Nothing sweeps, so **detection latency is the caller's poll interval** — which is what a caller sizes its heartbeat against (D12).

### Idempotency

**The caller supplies the key**, stable across its retries and its own to derive ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)); the Temporal factory derives it from workflow and activity identity. Starting with the same key *is* the idempotency operation — `ListTasks` filters by context and status but not by metadata, so the key is not queryable through the protocol and the store's index carries it. The task id is not the key: A2A mints it, a failed task is terminal, and a new attempt is a new task carrying `referenceTaskIds` to its predecessor, so the chain reads from the protocol alone.

- **Concurrent — guaranteed.** Attempts carry the same runtime session id and reach the same container, whose gateway is that session's single authority; a start whose key names a live task returns that task. The index insert is conditional, so two starts racing cannot both admit.
- **Later — within the record's retention**, which is **seven days**. The key includes the caller's *run* identity — for the Temporal factory, the workflow run id with the activity id — so a key belongs to one workflow run and nothing re-sends it afterwards; a reset, which re-executes with the same activity ids under a new run id, therefore runs fresh rather than attaching to the old outcome. Retention is a storage bound rather than a correctness one, and a repeated start after it runs again, with `start` reporting that it started rather than attached.

**The key rides in the client's call context, not in a procedure's input.** oRPC types what a caller supplies per call separately from the input, so the compiler requires a key on every `SendMessage` — and on nothing else — without any procedure having declared one. That requirement is carried by the client's own type, which is therefore AgentForge's to vend rather than a consumer's to write: a link may legally be typed more loosely and would simply ignore the key ([research](research/procedure-framework.md)).

A cancel from one caller ends a task other callers attached to, so the outcome distinguishes who asked: a caller that did not ask should treat it as retryable.

### Outcome

Typed; every failure carries its cause. Layer 1 reads only the kind and its retry guidance — the detail passes through untouched.

| Outcome | Retry guidance |
|---|---|
| `SUCCEEDED` | — |
| `OUTPUT_INVALID` — could not conform; payload preserved | Not blindly: a second identical run is not a correction |
| `OUTPUT_TOO_LARGE` — conformed, but over the 256 KB cap | No; the procedure must return references instead |
| `TURN_BUDGET_EXHAUSTED` | Consumer's decision |
| `TIMED_OUT` — the procedure's own budget | Consumer's decision |
| `DEADLINE_EXCEEDED` — the platform's 8-hour job cap, which no retry beats | No; the procedure must be split |
| `CANCELLED` — by this caller | No |
| `CANCELLED_BY_ANOTHER` — a different attached caller asked | Yes, as a new attempt |
| `LOST` — the container died; side effects may have happened | Yes, as a new attempt |
| `USAGE_LIMITED` — with the reset time | Wait until the reset, with jitter: one subscription serves every agent, so tasks hit the limit together |
| `CREDENTIAL_EXPIRED` | No; an operator must act |
| `PROVIDER_TRANSIENT` — with the provider's retry-after where it gave one | Yes, after that delay |
| `FAILED` — harness, SDK or procedure error, with its detail | Consumer's decision |

---

## 5. The container

One server: an A2A server on AgentCore's contract — `0.0.0.0:9000`, JSON-RPC on `POST /`, the card at `/.well-known/agent-card.json`, and `/ping` reporting the container's aggregate status. It is **assembled from `@a2a-js/sdk` and Express**, not built on the AgentCore SDK's `serveA2A`, whose options take an executor and offer no seam for the gateway ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md)). **It speaks A2A 1.0 and nothing else** ([ADR 0014](../adr/0014-agentforge-speaks-a2a-1-0-only.md)): the card declares one interface at `protocolVersion: '1.0'`, `legacyCompat` is disabled on both handlers, and the runtime allowlists the `A2A-Version` header the client sends. **An absent header means 0.3**, not "unspecified", so a missing allowlist entry would otherwise downgrade every call silently; with `legacyCompat` off it is refused on the first invocation instead. AgentCore reports that refusal as an opaque 424, which is why the client asserts the version it negotiated rather than inferring success from a 200.

**The gateway** decides admission (§4). **The executor** spawns and supervises: one process per task, in its own process group ([ADR 0004](../adr/0004-a-process-per-task.md)). Measured: **65 ms** to a task process ready to serve with the Agent SDK imported — 0.054 % of a two-minute run — and `/ping` p95 unmoved by four running tasks, two of them saturating a core ([research](research/task-process-and-cost.md)). The channel is a **dedicated bidirectional socketpair on fd 3**, so a task's own logging cannot corrupt its outcome; `detached: true` gives it its own process group, and `kill(-pid)` is what makes cancellation reach a grandchild.

- `/ping` shares no event loop with any task, so nothing a task does can stall the health check and get a busy session terminated (D31)
- **the server answers `/ping` within the platform's startup window**, so the container binds and serves before any slow initialisation — loading procedures, warming the SDK — happens behind it
- each task loads its procedures from the image it was deployed with (§6)
- a crash is contained: the executor records `FAILED` with the exit code and the tail of stderr, so a task never disappears without a record
- the process speaks the task protocol, and its logs go to the container's log stream

**Credentials live in the environment, for now.** The Agent SDK reads the operator's subscription token from there and offers no provider interface. A procedure's provider keys arrive the same way, from a secret store through AgentCore Identity. The agent's own shell can read both, which is recorded rather than mitigated: a container-level broker comes later, and the base image keeps room for it **[OPEN §O]**. An expired credential surfaces as `CREDENTIAL_EXPIRED` rather than a generic failure, and nothing AgentForge emits ever contains one (D24, D29). A credential proxy at the container level — brokering provider calls so their keys never sit in the task process's environment at all — is a worthwhile later addition for everything except the subscription token, and is **[OPEN §O]**. AWS credentials cannot be withheld from a child in the same microVM: the task process is *not given* store credentials, but store integrity rests on the microVM boundary, not on a scrubbed environment.

**Guardrails are cooperative.** `writeScope` and `stopGuard` constrain the model's tool use; they are not a sandbox, and a procedure with shell access goes around them.

**Locally**, the same image runs in Docker — rebuilt, not hot-reloaded, because a development-only code path is how a system drifts from what it ships. The client talks A2A to it directly, task state is on the filesystem behind the same fenced interface, and `docker stop` stands in for the blunt stop. The only thing mounted locally is the state that is mounted in the cloud. One code path; local is not a mock (D25).

---

## 6. Agents, images and delivery

Three levels, each a bundle of one or more of the next. **Where the lines fall is the consumer's**, exactly as identity is (§2); AgentForge vends the bottom one and the tooling.

| | What it is | Named | Changes when |
|---|---|---|---|
| **Base image** | AgentForge's: Bun, the Claude CLI, and one bundled server — nothing the server does not need | `agentforge/a2a-claude`, namespaced so variants can follow | The server changes |
| **Agentic base image** | The consumer's layer over it, named for the project that vends it: the skills, tools, MCP servers, prompt foundation, language runtimes and memory a group of agents share | `{consumer}/{project}` | Those capabilities change |
| **Agent's own build** | The consumer's procedures bundled with the harness they import from `@beruangai/agentforge` | — | Its procedures, or the AgentForge version it pins, change |
| **Agent** | A deployed AgentCore runtime, extending its agentic base image with its own procedures, card, mounts and stores | `{consumer}/{project}/{agent}` | Its own procedures or configuration change |

**One identity; AWS resource names are generated, not composed.** Several consumers, each with several packages and several agents, share a registry and an account, so the triple `{consumer}/{project}/{agent}` is the identity: it names the ECR repository, since slashes are what ECR namespaces with, and it is what a task's record and telemetry carry. It is *not* the AgentCore runtime name. `agentRuntimeName` is required, allows only letters, digits and underscores, and caps at 48 characters, so the construct generates it with CDK's [`Names.uniqueResourceName`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.Names.html) — bounded to 48, underscores as the only permitted special character — rather than composing a name that silently overflows. A caller addresses an agent by its ARN, resolved from the deployment rather than assembled: `@aws/nx-plugin` already does this through an AppConfig runtime configuration, with the ARN also available as a construct output for direct wiring and passed explicitly to the client in local development — so AgentForge publishes an agent's ARN the same way, keyed by the identity triple (D31, D32, [research](research/aws-nx-plugin.md)). Images are referenced by digest, never by a moving tag.

An agentic base image serving one agent, or an agent serving one procedure, is the same shape with a count of one. A consumer that wants an agent isolated from every other capability extends the base image directly.

**Two artifacts, versioned apart.** The base image carries the server and only the server; the harness travels with a consumer's procedures, bundled from the package they depend on. So an AgentForge server fix is a base image a consumer adopts when it chooses, and an AgentForge harness fix is a package bump that rebuilds only that consumer's agent images. The price is that the executor and the task process are independently versioned, which is why the task protocol opens with a version both sides must accept and refuses a mismatch before any work (§1).

**Code ships in the image** ([ADR 0008](../adr/0008-code-ships-in-the-image.md)). A deploy cannot interrupt a run: AgentCore keeps existing sessions on the artifact they started with and gives new sessions the new one. So nothing needs mounting to avoid churn — what a change must avoid is spreading, and layering is what stops it. A change to one agent's procedures rebuilds that agent's image alone; a change to shared capabilities rebuilds the images above it; a change to neither rebuilds nothing.

**That only holds if builds are deterministic, and it does hold.** Measured over one base, one agentic base and three agents: an unchanged rebuild is byte-identical, a change to one agent moves that agent alone, and a change to the agentic base moves all three above it and nothing below ([research](research/image-determinism.md)). Nx's affected graph decides what to rebuild; the **manifest** digest decides what to deploy — buildx's `--metadata-file` reports it, and `docker image inspect`'s image id must not be used, because the `docker` exporter leaves layer timestamps in place and its id moves on every build. Determinism needs `SOURCE_DATE_EPOCH` **and** `rewrite-timestamp=true` — the epoch alone normalises the config and leaves the layers moving — plus `--provenance=false`, every parent pinned by digest, and no unpinned package installs. **`bun build` is not a source of drift either** — byte-identical across runs, across a different absolute path, across changed source mtimes and under `--minify`, measured on a real 2.26 MB bundle. Determinism therefore rests entirely on the Docker-level requirements above. What remains **[OPEN §D]** is the deploy path that compares digests, not the builds it compares.

**State persists through APIs, not mounts** ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)), so an agent runs in public network mode and no consumer pays for a VPC to run one.

| State | How it persists | Whose |
|---|---|---|
| Session transcripts | The SDK's `SessionStore` adapter, over an object store's API, under a **project key: an AgentForge prefix plus a part the procedure supplies** — see below (D17) | AgentForge |
| The rest of the config directory | Baked into the image — settings, skills, plugins and user-tier memory are capabilities, not state | AgentForge |
| Working directories | Synced to an object store under a strategy the consumer declares, per agent or per procedure | The consumer declares; AgentForge runs it |
| Anything else | The consumer's own mechanism | The consumer |

The mirror is best-effort by design — three attempts, then the batch is dropped with a `mirror_error` — so it is verified rather than trusted: entries deduped by id, the transcript's last entry checked after the run, and a dropped batch failing the task rather than appearing in a log.

**The project key is derived, never supplied, and it is composed in two parts.** AgentForge owns the prefix — `{consumer}_{agenticProject}_{agent}_` — and **the procedure supplies the final part**. So continuity is scoped to an agent *and* to whatever the procedure says distinguishes its runs — a lane, a strategy, an entity — stated explicitly rather than inferred from a directory. Two procedures of one agent that should share a transcript scope say so by supplying the same final part.

`CLAUDE_CODE_PROJECT_DIR_NAME` carries it, which constrains the derivation: 1–64 characters of letters, digits, hyphens or underscores, no separators, and not a Windows device name. AgentForge sanitizes and, where the parts do not fit, truncates deterministically with a hash — the same treatment the runtime name gets (§6). Readability is preferred but not required; a deterministic short id derived from the full value is acceptable when the parts cannot fit. It also sets `CLAUDE_CONFIG_DIR`, without which the name is ignored. **An invalid name does not fail; the SDK silently falls back to a path-derived one**, so the run asserts the transcript landed under the expected key and fails the task if it did not.

**The sync strategy is the consumer's, declared whole at the agentic project and overridden in part by a procedure**: direction, whether deletes propagate, whether it runs continuously or once at the close, how often, and what is excluded. **Every field is required where it is declared** — there is no implicit default, so nothing behaves a way nobody chose — and a procedure supplies only the fields it differs on. A procedure wanting atomic hand-off overrides the cadence; one producing a long narrative leaves it continuous.

**What AgentForge guarantees, whatever the strategy:** the sync is flushed and verified *before* the outcome is published, so a task never reports `SUCCEEDED` over unsynced files and a failed flush fails the task; the sync runs in the task's own process group, so cancelling the task takes it too and nothing it does touches the event loop answering `/ping`; and a sync failure is an outcome, never a log line.

**No mount is supported**, and neither consumer needs one. A mount would mean `networkMode: VPC` and everything it drags in — NAT for `api.anthropic.com`, ECR, S3 and CloudWatch endpoints, subnets in allow-listed availability zones aligned with mount targets, paired rules on TCP 2049, ENIs outliving a deleted agent — so it is tabled until something asks for it (`DESIGN_OPTIONS.md`, Tabled). A consumer that wants one configures it in its own CDK. What the sync declaration covers is **[OPEN §F]**.

**The agent card is generated at build time** from the procedures the image contains, and served from the image: a mount is readable only during an invocation, and the platform may fetch the card outside one.

**A task's record carries the artifact version that ran it**, because while long sessions drain, two versions serve traffic at once.

**AgentForge ships the delivery tooling as an Nx plugin** on `@aws/nx-plugin`'s conventions: generators for an agentic project, an agentic base image, an agent and a procedure; a **sync generator** that keeps a consumer's wiring current as AgentForge changes, so iteration is a sync rather than ad-hoc patching across two repositories; CDK constructs for an agent with its A2A configuration, its stores, its mounts and `grantInvokeAccess` for a caller's least-privilege role (D32); and the build-and-deploy path that updates only what changed **[OPEN §K]**.

## 7. The harness

### Kernel

One `query()` to a settled outcome, behind the `agent()` helper:

- **Structured output** — the agent contract becomes the SDK's own `outputFormat` (draft-07), and the settled output is validated before anything else sees it. Not a helper a procedure can forget: a run without an agent contract is not expressible. The SDK validates and re-prompts natively, carrying the submission on a real tool named `StructuredOutput`. A result that arrives `subtype: success` with **no** `structured_output` is `OUTPUT_INVALID`, never success — a denial loop ends exactly that way ([research](research/kernel-settlement.md)).
- **Settlement** — the kernel calls the SDK in its **closed-input** form and takes the **first** result, then stops reading. Foreground dispatch is safe: a final submission survives subagents and long tool storms. What is not safe is open input, where a completing background task starts a new turn and publishes a second, contradictory result — D9's failure in its current shape. "Exactly one outcome" is the kernel's guarantee, not the SDK's.
- **Abort** — an `AbortSignal` and the SDK's interrupt reach the run; exactly one outcome is published. The kernel also **catches around the iterator**: `maxTurns` and `maxBudgetUsd` bind by throwing rather than by a result message, so `TURN_BUDGET_EXHAUSTED` is reachable only from the thrown error.
- **Session** — started, resumed or forked as the procedure said, with its transcript mirrored through a `SessionStore` so it resumes in any container (§6).
- **No blocking** — nothing in the kernel or a helper blocks the event loop.

### Library

Optional functions a procedure calls, each serving a stated requirement:

| Helper | Does |
|---|---|
| `writeScope` | Denies writes outside allowed paths, with allow-union semantics (D8) |
| `stopGuard` | Refuses to end a session while a required artifact is missing (D8) |
| `guardrailDisclosure` | Tells the agent which rules apply, derived from what is enforced (D8) |
| `telemetry` | OpenTelemetry export of the SDK's native telemetry, correlated to the task, flushed before the outcome (D23) |

Every helper that installs a `PreToolUse` matcher **asserts at startup that `init.tools` contains the tool it names**, because a matcher naming a tool that does not exist fires zero times and reports nothing. A helper that can compute the correct value repairs the submission through `updatedInput` rather than denying it: repair costs no additional model turn, and a denial whose reason contradicts the declared contract is refused by the model as an injected instruction ([research](research/kernel-settlement.md)).

The guardrail helpers serve TrendBot alone and wait for its contract to be confirmed; their *semantics* may belong in TrendBot's own package, with AgentForge carrying only the hooks (**[OPEN §L]**).

---

## 8. What every task records

Written by AgentForge: the outcome, the attempt and the prior attempt's state, timings, admission and cancel events, every identifier of §2, and any transcript-mirror failure — correlated to the caller's own ids (D22). For an agent run, also the prompt as sent, the resolved SDK options, where the transcript is, and usage: tokens, turns, cost (D22).

---

## 9. How this is tested

Three tiers, and a rule about what earns a test: **a spike becomes an integration test when its answer can drift.** An answer that depends on a platform or a dependency — the Agent SDK's settlement behaviour, AgentCore's contract, what a registry serves — is not self-renewing, so it lands in `integ/` and keeps being checked. An answer that settles a decision once, such as which authoring style a procedure uses or whether a binary runs on this architecture, is recorded in an ADR or a research note with its date. A test that can only pass is maintenance without information.

| Tier | Runs against | Covers |
|---|---|---|
| **Unit** | Nothing external | The procedure model, the outcome taxonomy, the store's fencing and index, event mapping — colocated with their source |
| **Runtime integration** | A real AgentCore runtime, with the model call stubbed | Everything around the agent: admission, idempotency, the task-process protocol, cancellation, the lease, loss, mounts and sync, deploy behavior. Deterministic and cheap, because no model is called |
| **End-to-end** | A real runtime and a real model | Structured output, settlement, in-turn correction, cancellation mid-turn, usage accounting — run after a change that could move them, not on every commit |

The stub in the middle tier replaces the SDK call *inside the kernel*. It is a test seam, not a second kind of procedure and not something a consumer can reach — a procedure is still an agent run (§3).

## Failures reproduced as tests

Each failure the predecessor harness paid for ([lineage](lineage/predecessor-harness.md)), and each the new boundaries introduce. The last seven are new; the final three were found by running against AgentCore on 2026-09-22 ([research](research/agentcore-runtime-observed.md)).

| Failure | Layer |
|---|---|
| Caller redeployed mid-run; the result had nowhere to go | 1 |
| Container killed mid-run (AgentCore 424) | 1 |
| A run outlasting the 15-minute synchronous request limit | 1 |
| `/ping` stalled by blocking work on the same event loop | 1 |
| A timed-out attempt left running while its retry started | 1 |
| A resumed turn publishing a second, contradictory outcome over the first | 2 |
| A result arriving `success` with no structured output, and being believed | 2 |
| A turn or budget limit that binds by throwing, surfacing as a generic failure | 2 |
| A hook matcher naming a tool that does not exist, and firing zero times | 2 |
| The result taken before dispatched work settled | 2 |
| Structured output lost to schema conversion | 2 |
| An SDK option accepted and silently dropped | 2 |
| A stale lease holder's write landing after a newer one | 1 |
| A cancelled task leaving subprocesses behind | 1 |
| A second live task admitted under one continuity key | 1 |
| A project key the SDK silently ignored, scattering transcripts | 2 |
| A task process whose protocol version the executor does not accept | 1 |
| Admission beyond the container's memory, killing its neighbours | 1 |
| A part delivered with its content silently stripped, under the `SendMessage` method name | 1 |
| A protocol version assumed rather than asserted, after a missing header allowlist entry downgraded the request | 1 |
| A capability layer missing from the session because a repository root cut the chain | 2 |
| A layer's permissions assumed to load from its own `.claude/`, which reads only from `cwd` | 2 |
| An additional directory readable but not writable, because the permission was implied rather than declared | 2 |
| A caller whose content type the A2A handler refuses, surfacing as an opaque 424 | 1 |
| Recovery attempted inside a stopped container, past the ~60-second kill | 1 |

---

## 10. What is published, and how the repository is laid out

**AgentForge vends one package.** A consumer depends on `@beruangai/agentforge` and nothing else — no independent versioning across a family of packages, no micro-dependencies for a consumer to keep in step. What prevents that package from polluting a caller's bundle is **entry points**, each exporting only what its environment may load:

| Entry point | For | Carries |
|---|---|---|
| `/contract` | Anywhere, including a worker | Contract declaration and types. oRPC and Zod only; never the Agent SDK |
| `/client` | A caller | The A2A client — the link over `InvokeAgentRuntime`, typed by an imported contract |
| `/temporal` | A Temporal worker | The activity factory over the client |
| `/agent` | A consumer's agent build | Procedures, the `agent()` helper, the kernel, the helper library — bundled into their image |
| `/infra` | A CDK application | The constructs |

The boundary is enforced, not documented: an import of `/agent` from a worker's build fails, because the contract half is the only thing both sides share ([ADR 0003](../adr/0003-procedures-are-type-safe-end-to-end.md)). The Nx generators ship in the same package, which is what makes the sync generator a version of AgentForge rather than a separate thing to upgrade.

**The server is not one of these.** It is never imported by a consumer: AgentForge's own build bundles it, and the base image is where it ships. That is what keeps an unrelated change to the client, the constructs or a generator from producing a new base image.

Internally the workspace is **organized by scope, never by type**, in the Nx grouped layout on `@aws/nx-plugin` defaults. Shape, not a commitment:

```
agentforge/
├── adr/  docs/  openspec/
├── apps/
│   └── runtime/
│       └── base-image/        # agentforge/a2a-claude, the image consumers extend
└── libs/
    ├── agentforge/            # the single published package: entry points, generators, build
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
    │   └── constructs/        # CDK: agent, task store, object stores, caller policy
    ├── tooling/
    │   └── plugin/            # Nx generators, including sync
    └── temporal/
        └── activity/          # activity factory over the client
```

Internal libraries are never published on their own; they are composed into the one package.

---

## 11. Deliberately absent

- **Any mapping between the four identifiers** — the consumer's, procedure by procedure (§2)
- **Queueing, and any concurrency ceiling that is not about memory** — the caller's (D15)
- **Recovery of a consumer's side effect** — the consumer's (§3)
- **Rate limiting or durability for the tools an agent calls** — a consumer-hosted MCP server owns its limits and whatever backs them
- **Agent discovery and agent-to-agent orchestration** — the card is generated and otherwise unused
- **Agent frameworks other than the Claude Agent SDK**
- **Procedures that invoke no agent** — AgentForge runs agents; a consumer's plain work belongs in the consumer
- **Synchronous invocation, streaming and blocking sends** — polling is the only way to wait until a procedure needs otherwise
- **Any second server in the container**
- **Consumer vocabulary** — no directive, entity, vault, or strategy
