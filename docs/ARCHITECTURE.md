# Architecture

AgentForge runs a consumer's **procedure** as an asynchronous **task** in a container, and returns a typed outcome to whatever called it. This document states what is built and decided. What is not decided is in [DESIGN_OPTIONS.md](DESIGN_OPTIONS.md); why a decision went the way it did is in an [ADR](../adr/README.md); what AgentForge answers to is [REQUIREMENTS.md](REQUIREMENTS.md).

**Simplicity is the design principle.** AgentForge is a few small, rock-solid capabilities for one engineer across a few projects. Layer boundaries and ownership are strict; inside a layer, the smallest design that is correct wins.

## 1. Layers

```
caller ─ client ──A2A 1.0──► RUNTIME: server → gateway → executor ──IPC──► task process
                                          │                                  │
                                    DynamoDB task store              CONSUMER: task entry
                                                                             │
                                                                     HARNESS: procedure → kernel → Agent SDK
```

| Layer | Owns | Knows nothing of |
|---|---|---|
| **1. Runtime** (`server/runtime`, `client`) | The wire, the gateway (idempotency, admission, continuity), the executor (a process per task, time budget, lease), task state, `/ping`, the card, the client | Claude, what a procedure does, who is calling |
| **2. Harness** (`server/harness`) | Running a procedure: validating its input, the kernel's one `query()` to a settled outcome, the outcome | A2A, AgentCore, callers, task state |
| **3. Consumer** | Its contracts and procedures, its identifiers, its side effects and their recovery, its images | How 1 and 2 work |
| **4. Claude Agent SDK** | The agent loop | — |

**Layers 1 and 2 never import each other.** Both import `core/`: the contract helpers, the task and outcome shapes, and the task-process messages. The consumer's **task entry** is the only place a harness meets a consumer's procedures, and the executor runs it as a command it is configured with. Temporal is a caller: `/temporal` sits over the client, and nothing below the client knows a caller exists.

**Two crossings are protocols; everything else is a function call.**

| Protocol | Between | Shape |
|---|---|---|
| **Wire** | Client ↔ server | A2A **1.0 only** ([ADR 0014](../adr/0014-agentforge-speaks-a2a-1-0-only.md)) JSON-RPC: `SendMessage` with `returnImmediately` starts or attaches, `GetTask` polls, `CancelTask` stops. The envelope is the message's one data part; the outcome is the artifact `outcome` ([ADR 0002](../adr/0002-a2a-is-the-boundary-contract.md)). Routed by the AgentCore session header, locally too |
| **Task process** | Executor ↔ task process | Node IPC (`serialization: 'json'`), the process in its own group. In: `run`, `cancel`. Out: `record` per agent run, then exactly one `outcome`. A process that exits without one failed ([ADR 0004](../adr/0004-a-process-per-task.md)) |

## 2. Identity

The consumer decides how identifiers relate; AgentForge carries and records them and imposes no mapping ([ADR 0007](../adr/0007-identity-is-the-consumers.md)).

| Identifier | From | Means | AgentForge |
|---|---|---|---|
| `runtimeSessionId` | AgentCore | One microVM and its container | Required on every call; routes it; recorded on the task |
| `contextId` | A2A | A conversation of tasks | Passed through; uuid7 when the caller gives none |
| `sessionId` | Agent SDK | One transcript | The procedure starts or resumes it through SDK options; recorded per run; deployed, its transcript persists in the agent's session bucket, so it resumes in any container |
| `cwd` | Agent SDK | The capability root: which `.claude/` layers apply | The agent's directory, `/workspace/agentic/agent`, unless the procedure sets it |
| filesystem | The procedure registers it; its scope, from the request | Files a procedure works on — shared and persistent, or scratch | Mounted before the handler, pushed as declared before the outcome is published ([ADR 0015](../adr/0015-filesystems-mount-around-a-procedure.md)) |
| idempotency key | The caller | One logical execution across its attempts | Required on `SendMessage` only ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)) |
| continuity key | The caller, optional | Whatever must not run twice at once — usually a Claude session | At most one live task per key in a container |

Mechanical invariants only: one live task per continuity key; an idempotency key belongs to one runtime session, and reusing it in another is refused; one process per task; **no queueing** — a start beyond the container's admission limit is `TASK_STATE_REJECTED`, never held (§REQ306). The limit defaults to 4 (`AGENTFORGE_ADMISSION_LIMIT`): measured on AgentCore's 2 vCPU / 8 GB container, the container idles at about 0.4 GB and each running task's CLI adds about 165 MB, so memory is not what bounds a light procedure — twelve ran at once with 5.7 GB free — and 4 leaves each task about 1.8 GB for what its tools do. An agent whose procedures are light raises it.

## 3. Procedures

**A procedure is an oRPC contract** ([ADR 0013](../adr/0013-a-procedure-is-an-orpc-contract.md)), declared in a module a caller imports without the Agent SDK:

```ts
export const helloAgent = {
  summarise: oc.input(z.object({ text: z.string() })).output(z.object({ summary: z.string(), words: z.number() })),
  sleepThenAnswer: oc.meta(timeBudget(300)).input(…).output(…),
};
```

**The implementation** registers against it with oRPC's own implementer. A handler is ordinary code: whatever runs before the agent, `context.runAgent(…)` once or more, whatever runs after. So `before` and `after` side effects are just code (§REQ205), and the outer output — computed fields and identifiers included — is built from the agent's structured output, which asks the model only for what it should fill in (§REQ102).

```ts
const os = implementAgent(helloAgent);
export const router = os.router({
  summarise: os.summarise.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: ['Summarise the text…', { tag: 'text', context: input.text }],
      output: z.object({ summary: z.string() }),    // the agent contract
      options: { cwd, maxTurns: 3, tools: [] },      // the SDK's own Options
    });
    return { summary: run.output.summary, words: count(run.output.summary) };
  }),
});
```

`TaskContext` carries the task and context ids, the runtime session id, the idempotency key, the attempt and the prior attempt's end, the caller's metadata, the cancellation signal, `runAgent`, and the mounted `filesystems` with their merged `filesystemPermissions`.

**Filesystems** ([ADR 0015](../adr/0015-filesystems-mount-around-a-procedure.md), spec `filesystem-lifecycle`) are the files AgentForge manages for a procedure, persistent or scratch, zero or more per procedure. A `Filesystem` kind implements two operations, `pull` and `push`; the base class runs the lifecycle from options declared whole, with no defaults of AgentForge's — a higher layer declares its defaults as a value its procedures spread: `path` (a kind sets a default or requires it), `access` (`READ_ONLY`, `READ_WRITE`), `scope` (a function of `{ input, context }` returning the `root` mounted and the `read` and `write` globs within it, the whole mount by default), `pull`, `push` (`NEVER`, `WHEN_COMPLETED`, `WHEN_ENDED`), `checkpoints` (off, or a push every N seconds leaving files changed in the last M; only with `WHEN_ENDED`). **Registration and lifecycle are separate**: `filesystems({ name: filesystem }, { inherit? })` is middleware that only adds to a registry on the context — a name registered again replaces the entry upstream, `inherit: false` drops everything upstream — and the harness appends one middleware to the procedure it calls, which runs innermost, mounts the registry, and gives the handler `context.filesystems.<name>` (its path and baseline allow rules, `Read(//path/<read>)` and `Edit(//path/<write>)`) and `context.filesystemPermissions` (all of them merged). AgentForge applies none: the handler passes them, or its own, to `runAgent`, in `dontAsk`. The harness unmounts once the outcome is known: a completed task pushes its `WHEN_COMPLETED` and `WHEN_ENDED` filesystems, a failed one its `WHEN_ENDED` ones, a cancelled one none, and the local copy is removed. A push that fails ends a completed task `FAILED` with `FILESYSTEM_UNSYNCED` (retryable), and a failed one keeps its own cause with the push's failure added; a failed pull fails the task before the handler runs; a failed checkpoint is logged. `ScratchFilesystem` is an empty directory of the task's own. `S3Filesystem` mounts a prefix of a bucket the deployment declared (`AGENTFORGE_FILESYSTEM_BUCKETS`) at a path the consumer gives, with `deletes` (only with `pull`, on a non-empty root) and `exclude` (regular expressions). **`s7cmd sync`** runs each pull and push as a child of the task process — so a cancel or a lost container takes it — from the static binary the base image installs, pinned by sha256. It verifies each object it transfers by ETag, compares by ETag so an unchanged file is not sent again, and never touches an excluded path: the consumer's `exclude`, any `..` segment, and on a push everything outside the write scope. A checkpoint leaves its quiet files with `--filter-mtime-before`.

**The client derives the calls, named as A2A names them.** `client.summarise.SendMessage(input, { runtimeSessionId, idempotencyKey })` returns a task view; `client.summarise.GetTask(taskId, { runtimeSessionId })` returns a union on the task's state, with the typed output reachable only on `TASK_STATE_COMPLETED`; `client.CancelTask(taskId, { runtimeSessionId })` sits at the root because nothing about cancelling is a procedure's. `awaitTask` polls `GetTask` to a terminal state. The output is parsed against the caller's own contract. Over AgentCore, a call refused while AgentCore creates a new session's container (`-32054`, `-32055`, which only calls overlapping the first receive) is repeated for about six seconds before the refusal is thrown; every JSON-RPC error AgentCore answers with is thrown as an `AgentForgeRequestError` with its code.

**The contract hash** is `ohash` of the input and output JSON Schema. The container refuses a task whose hash it does not implement, before any work (§REQ104). Meta does not move it.

**The time budget** is declared with the procedure (`oc.meta(timeBudget(seconds))`) and overridable per call; without either, the agent's default applies (§REQ202). The executor enforces it — a wedged process cannot time itself out.

**Options are the SDK's own type**, minus the two the kernel owns (`outputFormat`, `abortController`). `composeOptions(…parts)` deep-merges house defaults with a procedure's (`ts-deepmerge`): scalars replace, plain objects such as `env` merge key by key, and **every list accumulates without duplicates** — hooks per event, allowed and disallowed tools, and any other array, so a narrower part cannot remove an entry a broader one set. An MCP server named twice throws. No guardrail is lost to ordering (§REQ204).

**Side effects and their recovery are the consumer's.** A handler sees `attempt` and `priorAttempt` (its state and, for a failure, its cause). `LOST` means side effects may have happened.

## 4. Tasks

**A task's state is A2A's, verbatim.** AgentForge adds no state, only the typed cause a failed task carries.

| State | When |
|---|---|
| `TASK_STATE_SUBMITTED`, `TASK_STATE_WORKING` | Admitted; the task process runs |
| `TASK_STATE_COMPLETED` | The outer output is the outcome |
| `TASK_STATE_FAILED` | Every failure, with its cause |
| `TASK_STATE_CANCELED` | Cancelled |
| `TASK_STATE_REJECTED` | Refused before any work: unknown procedure, contract hash mismatch, invalid input, admission limit, continuity conflict |

| Cause | Retryable | From |
|---|---|---|
| `OUTPUT_INVALID` | no | The agent never produced conforming structured output, or the handler's output failed the contract; payload kept |
| `OUTPUT_TOO_LARGE` | no | The outcome is over 256 KB — return references, not content |
| `BUDGET_EXHAUSTED` | no | `maxTurns` or `maxBudgetUsd` ran out |
| `TIMED_OUT` | no | The task's time budget |
| `LOST` | yes | The lease lapsed: the container died or was stopped |
| `USAGE_LIMITED` | yes, after `retryAfter` | The subscription's rate limit, with its reset time |
| `CREDENTIAL_EXPIRED` | no | The token needs an operator |
| `PROVIDER_TRANSIENT` | yes | A provider 5xx or overload |
| `EXECUTION_ERROR` | no | Anything else: a crash (with its stderr tail), a handler error, a mirror error, a dead guardrail |

Every cause carries a `suggestedAction` — what to try first, per code, or specific to the failure (a dead guardrail says how to fix its matcher). A cause from a thrown error carries its `stackTrace` with the cause chain, cut to 4 KB; the task process logs the whole error to the container log.

A handler can end its task with any cause by throwing `TaskFailure`. A domain-level "no" is a successful output, never a failure (§REQ502).

**Lifecycle.**

1. **Start.** The gateway reads the envelope and requires the session header. It looks the idempotency key up. If the key names a live or completed task, it **attaches** and returns that task. If the task ended any other way, it starts attempt *n + 1* and tells it how the last one ended. It then checks admission and continuity. The executor publishes `SUBMITTED` synchronously, so `returnImmediately` answers at once, then spawns the task process.
2. **Run.** The executor renews a 60-second lease every 20 seconds while the process lives, and enforces the time budget.
3. **End.** The process sends its outcome and exits. The executor saves the final task, with its run records, before publishing it. A process that exits without an outcome is `EXECUTION_ERROR`, with the tail of its stderr.
4. **Cancel.** `CancelTask` always reaches the executor, never only the A2A SDK's default path. It sends `cancel`; the kernel interrupts the run, then aborts it after 3 s. After a 5 s grace the whole process group is killed, so nothing the task started outlives it (§REQ304).

**Waiting is polling.** `GetTask` reads one item. Streaming, blocking sends and push notifications are unused until a procedure needs them.

**Task state lives in DynamoDB** ([ADR 0006](../adr/0006-task-state-is-durable-outside-the-session.md)): one table, a `task#id` item holding the A2A task, its state and lease, and a `key#idempotencyKey` item pointing at the latest attempt. Both expire after seven days. A write never replaces a terminal state with a different one. **Loss is derived when read**: a live task whose lease has lapsed is written `LOST`, conditionally, so a late real outcome and the loss cannot both win. A lease of 60 seconds sits well above any renewal stall — a false `LOST` sends a consumer reconciling for nothing — and bounds detection at the caller's poll interval plus a minute (§REQ303).

**`/ping`** answers `HealthyBusy` while any task runs and `Healthy` otherwise. It controls the session's idle reaping, not delivery: a busy container still receives starts, polls and cancels.

## 5. The container

One Bun process runs the server — Express and `@a2a-js/sdk`, assembled rather than inherited ([ADR 0012](../adr/0012-the-server-is-assembled-not-inherited.md)) — on AgentCore's contract: `0.0.0.0:9000`, JSON-RPC on `POST /`, the card at `/.well-known/agent-card.json`, `/ping`. The consumer's server entry names its task entry — `startServer({ taskEntry: new URL('./task.ts', import.meta.url) })` — and the rest comes from the environment (`AGENTFORGE_AGENT_NAME`, `AGENTFORGE_TABLE_NAME`, and optionally the admission limit, default 4; the default time budget, 3600 s; and a DynamoDB endpoint for local runs, where it also creates the table).

Each task is a child process running the task entry under the server's own runtime and flags (`process.execPath`, `process.execArgv`), so `--conditions=agentforge-agent` carries over. The source is erasable TypeScript only (`erasableSyntaxOnly`), so the same entry runs on Bun in an image and on Node under vitest. The server's event loop never runs agent work, so nothing a task does delays `/ping` (§REQ707).

**Platform version V2.** Every container is restored from one snapshot taken after startup, and Bun's random generator is not snapshot-safe: once a process draws randomness before the snapshot, every restored instance replays the same stream, TLS included. So **the server draws no randomness before the snapshot** — its startup is imports and listening; the declared secrets and the telemetry collector, which need the network, are prepared on the first request after the restore, before any task — and every id is minted per request. Task processes start after the restore. The runtime integ check deploys as a consumer does, with a secret and telemetry, and fails if restored containers mint the same ids. A stopped container is killed about ten seconds after `SIGTERM`, busy or not; the server stops every task on `SIGTERM` inside that window, and anything that cannot finish there is left to the lease. Invocations during the ~3-minute `CREATING` window are refused, and the first just after `READY` can be, so a deploy waits for the runtime to serve (§7). Ids minted after a restore are distinct: Bun reseeds its random source ([research](research/agentcore-runtime-observed.md)).

**Credentials are in the environment.** The Agent SDK reads the subscription token there (§REQ705). On AgentCore the token is a Secrets Manager secret the operator creates, declared to `AgentRuntime` as `secrets`: the runtime's role may read those secrets alone, and the server reads them into its environment on the first request after the restore, before any task, failing that request and every later one if one cannot be read — a stopgap until AgentCore Identity (DESIGN_OPTIONS §I); AWS credentials for the store come from the runtime's role. AgentForge never emits either (§REQ603). The agent's own shell can read the environment; that is recorded, not mitigated (DESIGN_OPTIONS §O). Guardrail hooks are cooperative, not a sandbox.

## 6. The kernel

`context.runAgent({ prompt, output, options })` is one `query()` to a settled, typed outcome:

- **Streaming input**: one user message, held open until the first result, so `interrupt()` is reachable. The prompt is a string, content blocks, context blocks (a tagged fragment each) or a slash command with its context and documents; a document that cannot be read fails the run.
- **Structured output**: the agent contract becomes `outputFormat` through the Anthropic SDK's `transformJSONSchema` — inlined, input side, `enum` and `const` kept as constraints rather than folded into prose. The root must be an object: another root throws unless the run passes `wrapNonObjectOutput`, which nests it under `output` on the wire and unwraps it before parsing. A record (keys the contract does not name) throws, since every object is closed. A `success` result with no conforming `structured_output` is `OUTPUT_INVALID`, never success.
- **One outcome**: background work is off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), the first result is the outcome, and the stream is then drained for up to 30 s so a late `mirror_error` is still seen (§REQ206).
- **Classification from fields, never text**: the result's `subtype` and `api_error_status`, an assistant message's `error`, a rejected `rate_limit_event`'s `resetsAt`.
- **Dead guardrails fail the run.** On `init`, every tool-event hook matcher (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`) is evaluated against `init.tools` as Claude Code evaluates it. One that selects no tool would never fire, so the run fails before its first turn.
- **Sessions outlive their container** (§REQ402). Deployed, every run mirrors its transcript through the SDK's `SessionStore` to the agent's session bucket, which the construct names in `AGENTFORGE_SESSION_BUCKET`, and a `resume` in any container loads it from there. The store is the SDK's reference S3 adapter, made loud: a line that is not JSON fails the load, and an entry re-delivered by a retried batch is kept once. The mirror is best-effort, so the kernel verifies it: a `mirror_error` fails the run, and so does any assistant message the run streamed that the store did not accept ([ADR 0011](../adr/0011-state-persists-through-apis-not-mounts.md)). A procedure that names its own `sessionStore` uses it instead. Locally no bucket is named and transcripts stay in the container.
- **Each run is recorded**: the prompt's hash and size, the options as passed (env values and hook callbacks reduced to names, the system prompt to its hash), the session id, duration, turns, cost, `modelUsage` and terminal reason. The prompt as sent is logged whole to the container log under its hash, and is in the transcript (§REQ601).

## 7. Images and delivery

**Code ships in the image** ([ADR 0008](../adr/0008-code-ships-in-the-image.md)). Two levels:

| Image | Is | Built from |
|---|---|---|
| `agentforge/a2a-claude` | Bun (pinned by digest), bash, git, ripgrep, a non-root `bun` user, and the **container workspace** at `/workspace`: a Bun workspace whose root depends on the peers AgentForge's server and harness import — the SDKs, express, the A2A SDK, the DynamoDB client, oRPC and Zod — with AgentForge's bundle as the member at `/workspace/agentforge` | The `Dockerfile` shipped in the package, over the bundle and the `container-lock` task's output |
| The agent's | `FROM agentforge/a2a-claude`; its member at `/workspace/agentic/agent`, the run's cwd, started by Bun under `--conditions=agentforge-agent` | The consumer's `Dockerfile` |

Every layer is a workspace member with its own `package.json` — `agentforge`, then `agentic`, then `agentic/agent` (the root lists them as globs, so a member a lower layer lacks is simply absent) — and imports another layer by its package name, never a path or alias. A member declares `workspace:*` for the layers it builds on and **peers** for what a lower layer's root provides. Each layer commits `bun.lock` for the **whole workspace up to it**, generated by an Nx `lock` target that recreates the workspace's manifests and seeds Bun with the parent layer's lock, so every version the parent pinned stays pinned; the image copies it to `/workspace/bun.lock` and installs frozen, baking in only what the layer adds, with each package once in Bun's isolated store. The `container-lock` task writes the root manifest and lock (`container/workspace/`) and `container/workspace-lock.ts` is the generic step every layer's `lock` target runs. (The global install and `NODE_PATH` were tried and failed: `NODE_PATH` resolves with CommonJS conditions, and with no `node_modules` on the path Bun auto-installs an import from npm at run time. A root `preinstall` runs after resolution, too late to merge locks.) **Nx owns the chain**: each image and lock is an Nx target depending on what it bakes in, so ordering and staleness are Nx's, and only the leaf is ever pushed. A consumer may add its own layer between the two — an **agentic base image**, the member at `/workspace/agentic`: shared modules, MCP servers and dependencies, with its `.claude/` (skills, `CLAUDE.md`) composing into every agent's session from the parent of the agent's cwd — as one more `FROM`; [`examples/agentic-project`](../examples/agentic-project) is that shape, with two agents over one layer.

Where a run's files live has no default: the procedure registers its filesystems and gives the run their permissions, and keeps the cwd its agent's directory so the `.claude/` layers still apply.

The CLI refuses to run tools unattended as root, and its Bash tool needs `bash` named by `SHELL`; the base image provides both.

**Deploying is one construct**, `AgentRuntime` from `/infra`: the CDK L2 `Runtime` over A2A with `PlatformVersion: V2` set by property override (CloudFormation takes it; the CDK does not type it yet), `A2A-Version` added to the header allowlist, and the task table — the task store's own key and expiry, from `core/` — named to the server in `AGENTFORGE_TABLE_NAME`, and the **session bucket**, named in `AGENTFORGE_SESSION_BUCKET`: S3-managed encryption, public access blocked, SSL only, versioned with a day's undo window, transcripts expired after `sessionRetention` (30 days by default). The task table has point-in-time recovery. **No KMS anywhere, for now**; where a construct chooses against a checkov rule it records why on the resource (`CKV_AWS_18`, access logging, on the session bucket, which AgentForge alone uses), so a consumer's checkov inherits the reason, and an example's `checkov` target gates its `deploy`. `removalPolicy` covers both, `RETAIN` by default; `DESTROY` deletes the bucket only when it is empty, since emptying it would take a Lambda whose log group outlives the stack. **An S3 filesystem's bucket** is its own construct, `S3FilesystemBucket`, so several agents can share one: private, TLS-only, S3-encrypted and versioned, retained by default, its access logging left to the consumer's checkov config. `AgentRuntime` takes them as `filesystems: { name: bucket }`, grants read and write on each, and names their buckets to the harness in `AGENTFORGE_FILESYSTEM_BUCKETS`. **Each agent has a dashboard** (§REQ604): the server counts what AgentForge cannot rule out — `TasksStoppedMidTurn` (the container stopped with a task running), `TasksKilledAfterGrace` (a task outlived the grace after its interrupt), `TasksLost` (a task derived `LOST`), `OutcomesUnrecorded` (an outcome the store refused) — as CloudWatch metrics in namespace `AgentForge`, dimension `AgentRuntimeName`, each also logged as an `agentforge.metric` line, and the construct charts them beside AgentCore's invocations, errors, latency, sessions and resources for the runtime's default endpoint. The role may publish to that namespace alone. Everything else the L2 takes is the consumer's. The agent's image is a CDK asset built from its `Dockerfile`, as `@aws/nx-plugin` does, into the bootstrap's one asset repository. A **readiness probe** — a Lambda that is its own custom resource handler, updated with every new runtime version — asks the runtime for an unknown task until AgentForge's server answers "Task not found", so `cdk deploy` returns only once the agent serves, in any pipeline. `grantInvoke` gives a caller `InvokeAgentRuntime` on this agent alone (§REQ708). **Observability is AgentCore's**: tracing is on unless the consumer turns it off, so the runtime delivers its service spans to X-Ray beside the metrics AgentCore always publishes, for the CloudWatch GenAI Observability dashboard; the construct grants the execution role the `logs:PutResourcePolicy` that AWS documents for delivering spans to the agent's own log group, which the L2 role lacks. An account enables CloudWatch Transaction Search once before its first deploy. **The Claude CLI's own telemetry** reaches the same place through the ADOT collector in the base image: the server starts it on the first request after the restore, before any task, failing the request if it does not come up, points every task's CLI at it on localhost, and stops it last so it flushes (§REQ602). The collector signs with the runtime's role to CloudWatch's OTLP endpoints — spans to X-Ray (`aws/spans`), events to the runtime's log group, metrics to CloudWatch — and the construct grants the `PutMetricData` on CloudWatch's default dataset that OTLP metrics need. On the way, the collector maps the CLI's spans onto the GenAI semantic conventions GenAI Observability reads — the operation (`chat`, `execute_tool`, `invoke_agent`), token usage, the tool's and the agent's name, spans named `{operation} {target}` — and stamps each with the runtime session as `session.id`, as a container serves one session. How much is exported is one choice, `telemetry`, as a log level: `WARN` (metrics and error events), `INFO` (default: every event and trace, no content), `DEBUG` (prompts and tool content too), `ALL` (raw API bodies too). The CLI's stderr goes to the task's log, so an export error is seen. Locally nothing is exported. An example's `deploy` target runs `cdk deploy` on its `infra/app.ts`, giving the asset the base image's id as `extraHash`: CDK hashes only the agent's directory, so a change to the base alone would otherwise not redeploy.

## 8. The package

One published package, `@beruangai/agentforge`, with an entry point per environment:

| Entry point | For | Carries |
|---|---|---|
| `/contract` | Anywhere | `timeBudget`, `contractHash`, the task and outcome shapes, the envelope |
| `/client` | A caller | `createClient`, `awaitTask`, `localTransport`, `agentCoreTransport` |
| `/temporal` | A Temporal worker | `procedureActivity` |
| `/agent` | The agent's task entry | `implementAgent`, `runTaskProcess`, `composeOptions`, `TaskFailure`, the kernel |
| `/server` | The agent's server entry | `startServer` |
| `/infra` | A CDK app | `AgentRuntime` |

`/agent` and `/server` resolve only under the `agentforge-agent` export condition, so a worker's build cannot import them. Every entry also carries a `@beruangai/source` condition pointing at its source, for projects inside this workspace, and publishing strips it. What only one environment needs — the Agent SDK, the A2A SDK, Express, the AWS clients, Temporal — is an optional peer; oRPC and Zod are required peers, so a consumer's schemas and AgentForge's are one copy. Peer ranges are caret for stable packages and exact for pre-1.0 and beta ones.

```
packages/agentforge/          @beruangai/agentforge — the one Nx project that publishes
  src/core/                   contract helpers, task shapes, task-process messages
  src/server/runtime/         layer 1: server, gateway, executor, task store
  src/server/harness/         layer 2: implementAgent, task process, kernel
  src/client/                 the client and transports; temporal/ the activity
  src/infra/                  the AgentRuntime construct and its readiness probe
  integ/{local,aws,model}/    integration tests, by what they need
  Dockerfile                  the base image
examples/hello-agent/         AgentForge's own agent: the consumer path, verified end to end
```

Imports inside the package use `.ts` extensions, and `#core/*` for a module in `core/`. Everything built lands under `dist/{projectRoot}/<task>/`.

## 9. Testing

| Tier | Where | Against | Runs |
|---|---|---|---|
| `test` | Colocated `*.test.ts` | Nothing external; the kernel against a scripted `query()` | Every build |
| `integ` | `packages/agentforge/integ/` | One live slice: the runtime with real processes and DynamoDB Local (`local`), AgentCore (`aws`), the Agent SDK against a model (`model`) | Before publishing |
| `e2e` | `examples/*/e2e/` | The whole path: a caller, the client or the Temporal activity, the agent's image, a real model — in Docker (`local`) or deployed on AgentCore (`agentcore`) | Before publishing |

The examples are the dogfood: AgentForge's own agents, built and verified exactly as a consumer's would be — the image from the published bundle, the procedures through the client — before any consumer adopts a change. Rules are in `.claude/rules/testing.md`.

## 10. Deliberately absent

- A mapping between identifiers — the consumer's
- Queueing, and any concurrency ceiling that is not about the container's memory
- Recovery of a consumer's side effect
- Procedures that invoke no agent; frameworks other than the Claude Agent SDK
- Streaming, blocking sends, push notifications, agent discovery
- A second server in the container
- Consumer vocabulary
