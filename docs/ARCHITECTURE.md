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
| `sessionId` | Agent SDK | One transcript | The procedure starts or resumes it through SDK options; recorded per run |
| `cwd` | Agent SDK | The capability root: which `.claude/` layers apply | The procedure's option |
| idempotency key | The caller | One logical execution across its attempts | Required on `SendMessage` only ([ADR 0009](../adr/0009-the-caller-supplies-the-idempotency-key.md)) |
| continuity key | The caller, optional | Whatever must not run twice at once — usually a Claude session | At most one live task per key in a container |

Mechanical invariants only: one live task per continuity key; an idempotency key belongs to one runtime session, and reusing it in another is refused; one process per task; **no queueing** — a start beyond the container's admission limit is `TASK_STATE_REJECTED`, never held (§REQ306).

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

`TaskContext` carries the task and context ids, the runtime session id, the idempotency key, the attempt and the prior attempt's end, the caller's metadata, the cancellation signal, and `runAgent`.

**The client derives the calls, named as A2A names them.** `client.summarise.SendMessage(input, { runtimeSessionId, idempotencyKey })` returns a task view; `client.summarise.GetTask(taskId, { runtimeSessionId })` returns a union on the task's state, with the typed output reachable only on `TASK_STATE_COMPLETED`; `client.CancelTask(taskId, { runtimeSessionId })` sits at the root because nothing about cancelling is a procedure's. `awaitTask` polls `GetTask` to a terminal state. The output is parsed against the caller's own contract.

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

**Platform version V2.** Every container is restored from one snapshot taken after startup, so nothing that must differ per container is minted at startup — every id is minted per request. A stopped container is killed about ten seconds after `SIGTERM`, busy or not; the server stops every task on `SIGTERM` inside that window, and anything that cannot finish there is left to the lease. Invocations during the ~3-minute `CREATING` window are refused, so a deploy waits for `READY` and a probe ([research](research/agentcore-runtime-observed.md)).

**Credentials are in the environment.** The Agent SDK reads the subscription token there (§REQ705); AWS credentials for the store come from the runtime's role. AgentForge never emits either (§REQ603). The agent's own shell can read the environment; that is recorded, not mitigated (DESIGN_OPTIONS §O). Guardrail hooks are cooperative, not a sandbox.

## 6. The kernel

`context.runAgent({ prompt, output, options })` is one `query()` to a settled, typed outcome:

- **Streaming input**: one user message, held open until the first result, so `interrupt()` is reachable. The prompt is a string, content blocks, context blocks (a tagged fragment each) or a slash command with its context and documents; a document that cannot be read fails the run.
- **Structured output**: the agent contract becomes `outputFormat` through the Anthropic SDK's `transformJSONSchema` — inlined, input side, `enum` and `const` kept as constraints rather than folded into prose. The root must be an object: another root throws unless the run passes `wrapNonObjectOutput`, which nests it under `output` on the wire and unwraps it before parsing. A record (keys the contract does not name) throws, since every object is closed. A `success` result with no conforming `structured_output` is `OUTPUT_INVALID`, never success.
- **One outcome**: background work is off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`), the first result is the outcome, and the stream is then drained for up to 30 s so a late `mirror_error` is still seen (§REQ206).
- **Classification from fields, never text**: the result's `subtype` and `api_error_status`, an assistant message's `error`, a rejected `rate_limit_event`'s `resetsAt`.
- **Dead guardrails fail the run.** On `init`, every tool-event hook matcher (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied`) is evaluated against `init.tools` as Claude Code evaluates it. One that selects no tool would never fire, so the run fails before its first turn.
- **Each run is recorded**: the prompt's hash and size, the options as passed (env values and hook callbacks reduced to names, the system prompt to its hash), the session id, duration, turns, cost, `modelUsage` and terminal reason. The prompt as sent is logged whole to the container log under its hash, and is in the transcript (§REQ601).

## 7. Images and delivery

**Code ships in the image** ([ADR 0008](../adr/0008-code-ships-in-the-image.md)). Two levels:

| Image | Is | Built from |
|---|---|---|
| `agentforge/a2a-claude` | Bun (pinned by digest), bash, git, ripgrep, a non-root `bun` user — what the Claude CLI needs, nothing else | The `Dockerfile` shipped in the package |
| The agent's | `FROM agentforge/a2a-claude`; the consumer's dependencies installed from its lockfile, its source run by Bun under `--conditions=agentforge-agent` | The consumer's `Dockerfile` |

Nothing of the consumer's is bundled: the agent image runs `bun install --frozen-lockfile --production` and then its source. **Nx owns the chain**: each image is an Nx target depending on what it bakes in, so ordering and staleness are Nx's, and only the leaf is ever pushed. A consumer may add its own layer between the two — an agentic base image of shared tools — as one more `FROM`.

The CLI refuses to run tools unattended as root, and its Bash tool needs `bash` named by `SHELL`; the base image provides both. The deploy path is A2 (DESIGN_OPTIONS §D).

## 8. The package

One published package, `@beruangai/agentforge`, with an entry point per environment:

| Entry point | For | Carries |
|---|---|---|
| `/contract` | Anywhere | `timeBudget`, `contractHash`, the task and outcome shapes, the envelope |
| `/client` | A caller | `createClient`, `awaitTask`, `localTransport`, `agentCoreTransport` |
| `/temporal` | A Temporal worker | `procedureActivity` |
| `/agent` | The agent's task entry | `implementAgent`, `runTaskProcess`, `composeOptions`, `TaskFailure`, the kernel |
| `/server` | The agent's server entry | `startServer` |
| `/infra` | A CDK app | The constructs (A2) |

`/agent` and `/server` resolve only under the `agentforge-agent` export condition, so a worker's build cannot import them. Every entry also carries a `@beruangai/source` condition pointing at its source, for projects inside this workspace, and publishing strips it. What only one environment needs — the Agent SDK, the A2A SDK, Express, the AWS clients, Temporal — is an optional peer; oRPC and Zod are required peers, so a consumer's schemas and AgentForge's are one copy. Peer ranges are caret for stable packages and exact for pre-1.0 and beta ones.

```
packages/agentforge/          @beruangai/agentforge — the one Nx project that publishes
  src/core/                   contract helpers, task shapes, task-process messages
  src/server/runtime/         layer 1: server, gateway, executor, task store
  src/server/harness/         layer 2: implementAgent, task process, kernel
  src/client/                 the client and transports; temporal/ the activity
  src/infra/                  CDK constructs (A2)
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
| `e2e` | `examples/*/e2e/` | The whole path: a caller, the client or the Temporal activity, the agent's image, a real model | Before publishing |

The examples are the dogfood: AgentForge's own agents, built and verified exactly as a consumer's would be — the image from the published bundle, the procedures through the client — before any consumer adopts a change. Rules are in `.claude/rules/testing.md`.

## 10. Deliberately absent

- A mapping between identifiers — the consumer's
- Queueing, and any concurrency ceiling that is not about the container's memory
- Recovery of a consumer's side effect
- Procedures that invoke no agent; frameworks other than the Claude Agent SDK
- Streaming, blocking sends, push notifications, agent discovery
- A second server in the container
- Consumer vocabulary
