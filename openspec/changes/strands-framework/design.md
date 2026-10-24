# Design

*Guidance, not prescription: adapt to the actual constraints met while implementing, and update this document when one moves. The spike (group 1 of tasks) may move any decision below marked "the spike confirms"; one it overturns comes back to the operator before it is built on.*

## Context

See proposal.md — Why. What holds once `framework-seam` lands:

- **The seam.** `server/harness/framework.ts` defines `Framework<F>` (`name`, `prepare(): FrameworkRunner<F>`, `agentOptionsMiddleware`), with `FrameworkTypes` fixing `content`, `options`, `extras` and `usage`. `server/runtime/framework-server.ts` defines `FrameworkServer` (`requiredSecrets`, `telemetryEnvironment`, `collectorConfig`). `plugin/framework-plugin.ts` defines `FrameworkPlugin`. `framework/registry.ts` maps each provided framework to its plugin part, and `FRAMEWORK_NAMES` in `core/contract/framework.ts` is the one list.
- **The stub.** `src/framework/strands/harness/index.ts` holds placeholder `StrandsTypes` and a `strands` framework that throws. It is in no registry, export or bundle entry.
- **The image chain.** The base `agentforge/a2a` carries Bun, the collector, `s7cmd` and the shared peers. `agentforge/a2a-claude` extends the workspace root with the Anthropic SDKs; an agentic image is `FROM` its framework's image.
- **Strands in TypeScript,** checked at the source on 2026-10-22:
  - `@strands-agents/sdk` 1.22.0, with minors roughly weekly; `@strands-agents/harness` 0.3.1, whose minors break.
  - **Structured output** takes Zod 4 through a `strands_structured_output` tool. An invalid submission goes back to the model with no retry cap of its own. A model that never calls the tool is forced once, then `StructuredOutputError` is thrown. The spike found that two submissions in one message do not settle as documented (`docs/research/strands-agents.md`), so AgentForge settles them itself (The runner, below).
  - **S3 storage** for sessions, offloading and memory; TS throws without a storage backend.
  - **The Anthropic provider** supports cache points with a TTL, extended thinking with `effort`, and betas.
  - **Cancel:** an `AbortSignal` passed to the provider and checked at fixed points in the loop.
  - **Usage** includes cache reads and writes, and no USD cost.
  - **Silent defaults** AgentForge must override: an MCP server that fails to start yields no tools unless `continueOnError: false`.
  - **The Cedar intervention** (`vended-interventions/cedar`): the action is the tool name, the resource is fixed by config, the tool's arguments are `context.input`, and a `contextEnricher` adds fields (`cedar.ts:71,181-186`).
  - **Bun compatibility is unknown.**

## Goals / Non-Goals

**Goals:**
- A `strands` project is generated, synced, built, served and deployed exactly as a `claude` one is, and its procedures meet what every framework meets of settlement, sessions, context composition, distillation, observability and filesystems.
- Every Strands-specific line lives in `src/framework/strands/`, under the seam's lint rules.
- The seam changes only where Strands proves it short, and each such change is named in the spike's findings.

**Non-Goals:** as proposal.md, Non-goals.

## Decisions

### The SDK with selected vended tools, not the harness

[ADR 0023](../../../adr/0023-strands-runs-on-its-sdk-not-its-harness.md) (proposed) records the operator's choice and the alternative.

### A spike before any surface is fixed

The spike's findings go to `docs/research/strands-agents.md`, dated. Each finding is either relied on, and so earns a test (Testing below), or is a dated note. It covers:

- **Bun.** The SDK runs under Bun in a task process, Cedar's wasm included. If it does not, the work stops and the operator decides; no Node fallback is pre-approved.
- **Peers.** The SDK's full peer set for the provider, storage, Cedar, MCP and telemetry. And an `@anthropic-ai/sdk` version that serves both the SDK (`^0.109.1` at 1.22.0) and `claude` (`0.128.0`) in one workspace, where AgentForge's own and a consumer's hold both frameworks. If none does, the work stops for the operator.
- **Storage.** S3 storage against the local store's S3 and against AWS S3, a session resumed in another container, and memory and offloading in the same storage.
- **Cache points.** Block-level prompt caching on the Anthropic API, with explicit cache points and the SDK's automatic placement off, honoured on a second run.
- **Structured output** settling under the rules below.
- **Cancel latency** mid-tool.
- **The write scope:** a Cedar intervention fed by a `contextEnricher` refuses a file-tool edit outside the write globs.
- **The layers' directory and file names** Strands' skills plugin and conventions use.
- **The spend limit:** what the Anthropic API answers when the Console's spend limit is reached.

### The runner

`framework/strands/harness/` implements `Framework<StrandsTypes>`. `prepare()` reads the environment once per task process: the session bucket and agent name, the S3 endpoint, the API key, and the telemetry. It returns a runner whose `runAgent` builds one Strands `Agent` per run on the Anthropic provider, and invokes it with the task's signal.

- **One outcome (§REQ206).** Nothing runs in the background. AgentForge passes no subagent or tool that backgrounds, and a run that configures one fails `EXECUTION_ERROR` before it starts. Memory and storage writes Strands defers are flushed (`agent.shutdown()`) before the run returns, so none is lost with the process. The first accepted structured output is the outcome.
- **In-turn validation (§REQ208).** A `BeforeToolCall` hook on `strands_structured_output` parses the submission against the agent contract and runs every stop guard. It refuses with every failure in one message through `validateStructuredOutput` in `server/harness/`, which `claude`'s hook calls too.
  - AgentForge counts the attempts and fails `OUTPUT_INVALID` with the last refusal at the cap. The cap is five by default, as the Claude CLI's, and a run sets another as `maxStructuredOutputAttempts`.
  - Submissions are validated one at a time, in the order the agent made them, and the first accepted is the outcome. A later submission is told the run is ending, and the next model call is cancelled, since Strands does not settle on it.
  - A turn that ends without an accepted submission fails `OUTPUT_INVALID` at once: Strands would force the tool next, and the current models refuse the forced call. Strands' `StructuredOutputError` is classified `OUTPUT_INVALID` for any case left.
- **Cancel (§REQ304).** The task's signal aborts the invocation. The executor's grace and process-group kill stay as they are.
- **Fail closed (§REQ201).** Every MCP client must start: a run whose client sets `continueOnError: true` fails `EXECUTION_ERROR` before it starts, and one that does not start fails it before the first turn. Each client is connected with the task's signal and disconnected once the run is over, however it ended. A Strands hook has no matcher, so there is no dead matcher to refuse.
- **Storage (ADR 0011).** A storage call that fails — a write, a read, a list — fails the run `EXECUTION_ERROR`, naming it. The SDK would otherwise swallow it: a refused write in a hook, an unoffloaded result, or no memory recalled. A missing key reads as `null` and is not a failure.
- **Shutdown.** `agent.shutdown()` that fails fails the run, since what Strands defers may be lost. A telemetry flush that fails is logged, and the outcome stands.
- **The client is the runner's.** `modelConfig` takes neither `apiKey`, `client` nor `clientConfig`: the runner sets the key (§REQ714) and the request's cancel.
- **The record (§REQ601).** The shared fields, `usage` from Strands' accumulated usage, `rawUsage` its own, no `totalCostUsd`, and `framework` `{ name: 'strands', fullName: '@strands-agents/sdk@<pinned>' }`.

### Errors and the causes they map to

| Strands or provider signal | Cause | Retryable |
|---|---|---|
| A submission still refused at the cap; a turn ended without an accepted submission; `StructuredOutputError` | `OUTPUT_INVALID` | no |
| The provider's `max_tokens` stop, or a run's own limit | `BUDGET_EXHAUSTED` | no |
| The Console's spend limit: 400 `invalid_request_error` whose message starts `You have reached your specified API usage limits` or `You have reached your specified workspace API usage limits` | `BUDGET_EXHAUSTED`, with its own suggested action | no |
| The tier's monthly spend cap: 429 `rate_limit_error` with `error.details.error_code` `enforced_spend_limit_reached` | `BUDGET_EXHAUSTED`, with its own suggested action | no |
| HTTP 401 or 403 from the provider | `CREDENTIAL_EXPIRED` | no |
| HTTP 429 rate limit | `USAGE_LIMITED`, `retryAfter` from the provider's reset header | yes |
| HTTP 5xx or `overloaded_error` | `PROVIDER_TRANSIENT` | yes |
| A connection error or timeout, which has no status: the Anthropic SDK's `APIConnectionError` class, by name (operator, 2026-10-23) | `PROVIDER_TRANSIENT` | yes |
| The task's signal | the task ends `TASK_STATE_CANCELED` | — |
| A storage write, read or list that fails | `EXECUTION_ERROR`, naming the call | no |
| An MCP server that does not start | `EXECUTION_ERROR`, before the first turn | no |
| A stop guard that throws | `EXECUTION_ERROR` | no |
| Anything else | `EXECUTION_ERROR` | no |

Classification reads fields: HTTP status, the provider error's `type`, the stop reason, from the error objects Strands surfaces. `framework/strands/` imports no Anthropic package directly, so the lint rule confining them to `framework/claude/**` stands. If the spike shows classification needs the Anthropic SDK's own error types, that is raised before the rule changes. **The Console's spend limit is the one exception classified from text.** The API documents no field for it, only the message prefix (platform.claude.com/docs/en/api/rate-limits, 2026-10-23). The operator chose on 2026-10-23 to classify it by that documented prefix, without a live test, as a recorded exception to §REQ501. The tier's cap is classified by its field. The suggested actions are `strands`' own, passed through `cause()`, as `claude`'s are.

Alternatives weighed:
- The spend limit as `USAGE_LIMITED`, retryable after the reset. Rejected by the operator on 2026-10-22: the limit resets monthly, so the operator raises it rather than a workflow waiting a month.

### Filesystems: the write scope by Cedar

The framework's `agentOptionsMiddleware` renders each mount into Strands options:

- the mount's path in `workingDirectories`, which the system prompt names as where the agent works; the file tool takes absolute paths and refuses relative ones and `..`, and no tool's own working directory changes;
- one Cedar authorisation intervention for the run, from every mount's permissions.

A glob cannot be the Cedar resource, and Cedar's `like` has only `*`, which also matches `/`. So the `contextEnricher` resolves each tool call's paths against the mounts, matching with the same matcher `writablePath` uses. It sets `context.withinWriteScope`. The policy permits an edit action only when that is true. A shell command's writes are not bounded by the policy, since a command can write without naming its path (`cd`, variables, subshells). Which commands run is the procedure's allow list, as for `claude`'s Bash. The spike confirms the shape.

There is no read fence: `claude`'s fence is Claude Code's. Strands' reads follow its tools and the policy.

Alternatives weighed:
- One Cedar resource per glob. Rejected: Cedar cannot express a glob's single-segment `*`.
- A `BeforeToolCall` hook with no Cedar. Kept as the fallback if the intervention cannot see the arguments it needs. It is the same check, without the policy language.

### Sessions, memory and offloaded results in one storage

The operator chose one storage on 2026-10-22. Strands' `S3Storage` holds sessions, memory and offloaded tool results in the project's session bucket, under the agent's name, `<agent>/…`. Locally it is the local store's bucket of the same name, through `AGENTFORGE_S3_ENDPOINT` (ADR 0020).

- **Sessions (§REQ402)** resume by the Strands session id, which the run returns as `sessionId` and records with where it is stored.
- **Memory (§REQ404, reworded).** A run declares `memorySpace?: string`, a `StrandsTypes` extra. Its memory is kept under `<agent>/memory/<space>/`, recalled by a later run that declares the same space. With none declared, the run is given no memory. A space is the agent's own: its role reads and writes only under its name.
- **Offloading** is off unless a run declares `offload`. It writes under the same prefix, and never evicts: the SDK deletes an entry after 20 cycles and swallows a refused delete, and the agent's role may not delete. The operator chose on 2026-10-23 to keep offloaded results until the bucket's retention removes them.
- **A write the storage refuses** fails the run `EXECUTION_ERROR`, as `claude`'s mirror check does.
- **ADR 0011 is extended,** not replaced, with a dated note: a framework persists its state through its own storage API into the session bucket, under the agent's name.
- **The glossary's *memory space*** becomes framework-neutral: one space of an agent's memory, a `claude` run's memory directory or a `strands` run's prefix in its storage.

The reworded §REQ404: *an agent may keep memory across its tasks, in a space its run declares, so a later task recalls what an earlier one saved. It is optional: a run that declares none keeps none.*

Alternatives weighed:
- Strands memory on a mounted `S3Filesystem`, as `claude`'s auto memory is. Rejected by the operator in favour of the one storage.

### The layers' instructions and skills: Strands' own names

The operator chose this on 2026-10-22. The layers compose in `claude`'s order, base then agent, under Strands' own directory and file names. The operator recalls `.agent/` and `AGENTS.md`; the spike confirms them at the source.

- There is no `$` mapping: the plugin part's `configurationDirectory` has the same source and target.
- The runner reads each layer's instruction file into the system prompt, base first, after the procedure's own prompt and before AgentForge's fragments.
- It points the vended skills plugin at both layers' skill directories.
- A file that exists but cannot be read fails the run before it starts.

### The system prompt

AgentForge appends its fragments after the procedure's own system prompt, and never uses a preset. Strands has none, so ADR 0017's rule holds as written and needs no amendment. ARCHITECTURE §6 states it for `strands`. §ODO013 stays `claude`'s.

### Context and caching

- `composeContext`'s shared content renders to Strands text blocks.
- A context block read from `filepath` is read against the run's working directory, as for `claude`.
- A cache breakpoint becomes a cache point after the block, with its TTL (`true` is one hour). The SDK's automatic placement is off.
- `strands`' own prompt content (`StrandsTypes['content']`) is the SDK's content block.

### `distill`, transcripts and telemetry

- **`distill`** is `strands`' own, in `/strands/agent`, with the same contract as `claude`'s (§REQ209): one utility run, no tools, a Haiku model by default.
- **`readSession(run)`** in `/strands/client` reads a recorded run's session back from the storage, as `claude`'s `readTranscript` does, so a caller can read what a run did (§REQ601). It loads the SDK and the S3 client only when called.
- **Telemetry (§REQ602).** `prepare()` starts Strands' OpenTelemetry export to the collector on localhost. `FrameworkServer.telemetryEnvironment` sets the OTLP variables per level, and `collectorConfig` is `strands`' own, with no remapping: the spans are already `gen_ai.*`.

### Credentials and secrets

[ADR 0022](../../../adr/0022-a-framework-that-cannot-use-the-subscription-uses-an-api-key.md) (proposed) records the decision.

- `framework/strands/core/secrets.ts` declares `REQUIRED_SECRETS = ['ANTHROPIC_API_KEY']`, which its server, infra and plugin parts import.
- §REQ705 is withdrawn and §REQ714 added, as the ADR words them.
- **A `claude` run authenticates with the subscription (§REQ714).** The CLI prefers `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_API_KEY` to `CLAUDE_CODE_OAUTH_TOKEN`, and in headless mode always uses them. Where both frameworks share an environment, `strands`' key would win. So while the token is present, `claude`'s kernel leaves both out of the CLI's environment, and refuses a run that sets either itself. The operator chose this on 2026-10-23 over splitting each target's environment by framework.

### Public surface

```ts
// @beruangai/agentforge/strands/agent  (agentforge-agent condition)
export const framework: Framework<StrandsTypes>;
export function implementAgent<Contract extends RouterContract>(contract: Contract): Implementer<…, TaskContext>;
export function runTaskProcess(options: { contract: RouterContract; router: Router<TaskContext> }): void;
export interface TaskContext extends SharedTaskContext<StrandsTypes> {}
export type StrandsTypes = {
  content: ContentBlock;                       // the SDK's
  options: StrandsOptions;                     // model, maxTokens, tools, mcpClients, interventions, …
  extras: { memorySpace?: string; maxStructuredOutputAttempts?: number; resume?: string; offload?: { maxResultTokens: number; previewTokens?: number } };
  usage: StrandsUsage;                         // the SDK's accumulated usage
};
export type AgentRunSpec<O> = SharedAgentRunSpec<StrandsTypes, O>;
export type AgentRun<O> = SharedAgentRun<StrandsTypes, O>;
export function composeOptions(...parts: Partial<StrandsOptions>[]): StrandsOptions;
export function hook<E extends HookableEvent>(event: HookableEventConstructor<E>, callback: HookCallback<E>, options?: HookCallbackOptions): StrandsHook;
export function distill(context: TaskContext, spec: DistillSpec): Promise<readonly ContextBlock[]>;

// @beruangai/agentforge/strands/server  (agentforge-agent condition)
export const framework: FrameworkServer;

// @beruangai/agentforge/strands/infra
export const REQUIRED_SECRETS: readonly ['ANTHROPIC_API_KEY'];

// @beruangai/agentforge/strands/client
export function readSession(run: RunRecord, options?: { client?: S3Client }): Promise<readonly Message[]>;
```

`composeOptions` keeps the seam's rule that every list accumulates: tools, MCP clients, plugins, hooks, interventions and working directories. Strands takes no hooks in its `Agent`'s options, only through `agent.addHook`, so `StrandsOptions.hooks` holds each as `hook(event, callback, options?)` makes it — the callback typed by its event — and the runner registers them after its own (operator, 2026-10-24). A narrower part cannot remove a guardrail, and an MCP client named twice throws, as an MCP server named twice does for `claude`.

**The seam may change** where the spike proves it short. The one change foreseen: `prepare()` may become async, if Strands' telemetry or storage setup must await. Any change is named in the findings and lands in shared code and in `claude` together.

### Images and the plugin

- **`agentforge/a2a-strands`,** from `framework/strands/Dockerfile`, `FROM` the base. Its `container/` root manifest is the base's plus `@strands-agents/sdk` and the peers the spike settles, locked by `container-lock-strands`, seeded with the base's lock. It adds what the vended shell tool needs, which the spike names, and no Claude binary. The package gains the `image-strands` target.
- **The plugin part,** `framework/strands/plugin/`:
  - scaffolds the base `options.ts`, which names the model, and each layer's placeholder instruction file and `skills/`. Fail-closed MCP and no background work are the runner's to enforce, so the scaffold does not restate them;
  - `containerPeers`: `@strands-agents/sdk` and its peers that the framework uses;
  - the entry imports `/strands/agent`, `/strands/server` and `/strands/infra`;
  - image paths `strands/Dockerfile` and `strands/container`;
  - `configurationDirectory` the confirmed directory, the same as source and target;
  - `requiredSecrets` from `framework/strands/core/`.
- `FRAMEWORK_NAMES` becomes `['claude', 'strands']`, and the registry and `schema.json` enum follow, pinned by the existing test.

### Examples

The operator chose two on 2026-10-22, both generated with `--framework strands`:

- **A realistic non-coding project,** `research-brief`: an agent reads a set of documents from an `S3Filesystem` and returns a typed brief, and a declared memory space keeps a glossary across tasks. Every claim cites a document in its own words through the run's agent contract, built per run with a refinement, since a stop guard sees no submission; the stop guard holds the answer until every document is read (operator, 2026-10-23).
- **`strands-smoke`:** one agent covering what the framework touches: a resume in another container, a cancel mid-tool, and a filesystem across containers. Attach, a container stop ending `LOST`, and the Temporal activity are the runtime's and the client's, below the seam; `smoke-coverage` proves them, and they do not change with the framework.

## Testing

- **Unit (`test`), against a scripted Anthropic provider:**
  - the runner's settlement — the default and a set cap, the first accepted submission, a guard's reason, a throwing guard, a turn ended without one;
  - classification, over each row of the error table;
  - the record;
  - `composeOptions`' accumulation;
  - the middleware's rendering and the Cedar policy over in-scope and out-of-scope paths, through the file tool;
  - the layers' instruction order;
  - fail-closed MCP, and each client connected with the task's signal and disconnected after;
  - memory kept and recalled across runs, none without a space, and a failed storage call on each path;
  - the plugin part's snapshots and the enum test.
- **`integ/model/strands-structured-output/` and `integ/model/strands-cache-points/`** — what AgentForge relies on, the documentation does not settle, and can drift:
  - structured-output settlement under the hook against a real model: a contract's JSON Schema accepted as the tool's input, and a refusal told in the turn answered by a submission that is accepted. The cap and two submissions in one message are scripted in the unit tier, which settles them whichever way a model would;
  - cache points honoured on the Anthropic API.
- **`integ/local/`:** S3 storage against the local store, a session written by one process and resumed by another.
- **`integ/aws/`:** the same storage against AWS S3 under the agent's role.
- **e2e:** both examples, locally and on AgentCore.
- **Settled once, a dated note, not a test:** Bun compatibility, cancel latency, the spend limit's answer, and the layers' directory names. Each is a decision the spike makes once; a regression shows in the e2e.

## Risks / Trade-offs

- **[Risk] Strands moves weekly.** → Mitigation: the image's frozen lock pins the tested version, and a raise reruns the model tier.
- **[Risk] Two Anthropic SDK versions.** The SDK peers `@anthropic-ai/sdk ^0.109.1` and `claude` pins `0.128.0`. → Mitigation: the spike settles one shared version first, or the work stops for the operator.
- **[Risk] The spike overturns a decision:** Bun, the Cedar shape, or the spend limit classifiable only from text. → Mitigation: the spike comes first, and any overturn stops the work for the operator.
- **[Risk] The seam proves short.** → Mitigation: it was built with a typechecked stub for exactly this; a change is made in shared code and `claude` together, never as a `strands` branch.
- **[Trade-off] No read fence, and the shell is unbounded by Cedar.** A `strands` agent's shell can read the container outside its mounts, and can write wherever its allowed commands write. It is recorded as for `claude`'s Bash; Cedar bounds the file tool's edits only.
- **[Trade-off] Pay per use.** A runaway procedure spends up to the monthly limit.

## Migration Plan

None: no consumer has adopted AgentForge, so the change is v0, neither breaking nor additive. `references/migrations.md` gains a short entry: `strands` is available, and §REQ705 has become §REQ714. The examples land in the same change.
