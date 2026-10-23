# Design

*Guidance, not prescription: adapt to the actual constraints met while implementing, and update this document when one moves.*

## Context

See proposal.md — Why. What holds today:

- **The harness is one module, `server/harness/`, mixing shared and Claude code.**
  - **Shared:** `executeProcedure` and `runTaskProcess`, the filesystems, `composeContext`.
  - **Claude:** `kernel.ts`, which also defines the shared `TaskFailure` and `TaskCanceled`; `prompt.ts`, whose `CacheBreakpoint` and `ContentBlock` are Anthropic SDK types; `structured-output*.ts`, which also defines the shared `StopGuard`; `system-prompt.ts`, `auto-memory.ts`, `session-store.ts`, `distill.ts`, `options.ts`.
  - **The boundary leaks through types.** `TaskContext.runAgent` takes the kernel's `AgentRunSpec`, whose `options` is the SDK's `Options`. `TaskContext.agentOptions` is `Pick<AgentOptions, 'additionalDirectories' | 'allowedTools'>`.
- **The filesystems render Claude rules.** The registry middleware mounts every registered filesystem and builds `agentOptions` from each mount's `permissions.allow`, which is `Read(//<localPath>/**)` plus `Edit(//<localPath>/<glob>)`. It is appended innermost by `runProcedure`.
- **Claude assumptions outside the harness:**
  - `core/s3-session-store.ts` implements the SDK's `SessionStore`.
  - `core/secrets.ts` exports `REQUIRED_SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN']`, used by `AgentRuntime`, the plugin's constructs, the `serve` executor and the server.
  - `core/contract/task.ts`'s `SUGGESTED_ACTION_BY_CODE` names `claude setup-token`, the subscription and `maxTurns`/`maxBudgetUsd`. `cause()` already takes a `suggestedAction` override.
  - `core/telemetry.ts` documents its levels as the CLI's. `server/runtime/telemetry.ts` writes the CLI's variables into `process.env`, and `collector/` maps `claude_code.*` spans.
  - `client/transcript.ts` loads the SDK lazily.
- **The container workspace.** The root manifest's members are `agentforge`, `agentic` and `agentic/agent`. Its dependencies are every peer the server and harness import, both Anthropic SDKs included, so the bundle at `/workspace/agentforge` resolves them from the root's `node_modules`. One `Dockerfile` builds `agentforge/a2a-claude` from the bundle and `container/`.
- **What the plugin generates:**
  - the task entry, importing `runTaskProcess` from `/agent`;
  - the server entry, as `startServer({ taskEntry, requiredSecrets })`;
  - the agent construct, typed by the layers' `REQUIRED_SECRETS`, with AgentForge's taken from `core` inside `AgentRuntime`;
  - `serve`, which adds `core`'s `REQUIRED_SECRETS` to the secrets it passes.

## Goals / Non-Goals

**Goals:**
- Every Claude-specific line in the package's source lives in `src/framework/claude/`, reachable only through `/claude/*` entry points, with lint proving no shared module reaches it.
- The `claude` framework's run behaviour is unchanged. Tests change only where the surface they assert moved: imports, permissions as data, the run record's usage fields, generator snapshots.
- A typechecked Strands stub fits the interface without casts.

**Non-Goals:** as in proposal.md. Also none of these:
- moving tests between tiers;
- renaming `integ/` dimensions;
- changing the task-process protocol.

## Decisions

### Why the whole seam now, not only the consumer surface

The operator chose the whole seam — interface, stub, image split and plugin record — over the consumer surface alone, on 2026-10-22. [ADR 0021](../../../adr/0021-an-agentic-project-chooses-its-framework.md) records the options, the departure from "seams, not speculative abstractions", and its mitigations.

### Layout and boundaries

```
src/
  core/ server/runtime/ server/harness/ client/ infra/ plugin/    shared, unchanged in role
  framework/
    registry.ts  every provided framework's plugin part, by name: the plugin's one way in
    claude/
      core/      what spans the framework's layers, held to core/'s rules: the S3 session-store
                 adapter, REQUIRED_SECRETS, the SDK version the bundle pins
      harness/   kernel, prompt rendering, structured output and validation, system prompt,
                 auto memory, the session store from the environment, distill, options,
                 composeOptions, the agentOptions middleware, suggested actions
      server/    the framework's server part: telemetry, collector configs, core's secrets
      client/    readTranscript, over core's adapter
      infra/     core's required secrets, for constructs
      plugin/    scaffolds, base options, container peers, entry imports, the Dockerfile path,
                 the layers' configuration-directory lines ($claude → .claude)
      Dockerfile
      container/ the framework's root manifest and its lock
    strands/
      harness/   the stub, registered nowhere
```

`biome.json`:

- **Shared modules never import a framework.** `core/`, `server/`, `client/`, `infra/` and `plugin/` may not import `src/framework/**`. The one exception is `plugin/**`, which may import `src/framework/registry.ts`.
- **Frameworks never import each other.** `framework/claude/**` may not import `framework/strands/**`, and the reverse.
- **The layer rules hold inside each framework.** The existing patterns ban by folder name (`**/runtime/**`, `**/server/**`), which a framework's parts do not share, so each framework part gets its own restricted groups:

  | Part | May not import |
  |---|---|
  | `framework/*/core/**` | the framework's `harness/`, `server/`, `client/`, `infra/`; shared `server/`, `client/`, `infra/` |
  | `framework/*/harness/**` | the framework's `server/`, `client/`, `infra/`; shared `server/runtime/`, `client/`, `infra/` |
  | `framework/*/server/**` | the framework's `harness/`, `client/`, `infra/`; shared `server/harness/`, `client/`, `infra/` |
  | `framework/*/client/**` | the framework's `harness/`, `server/`, `infra/`; shared `server/`, `infra/` |
  | `framework/*/infra/**` | the framework's `harness/`, `server/`, `client/`; shared `server/`, `client/` |
  | `framework/*/plugin/**` | the framework's `harness/`, `server/`, `client/`; shared `server/`, `client/` |

  Every part may import its framework's `core/` and shared `core/`.
- **The Anthropic SDKs** (`@anthropic-ai/claude-agent-sdk`, `@anthropic-ai/sdk`) are importable only under `framework/claude/**`. Within it, `client/` keeps the client rule's ban on them, with today's one marked exception: `readTranscript`'s type-only import and its lazy `import()`.

`core/s3-session-store.ts`'s exception goes away, because the adapter moves under `framework/claude/core/`, where the SDK is allowed. `transcript.ts`'s exception stays, moved with it.

Alternatives weighed:
- Per-module framework subfolders (`server/harness/claude/`). Rejected: a framework would not read or delete as one folder.
- An Nx project per framework. Rejected: there is one publishing project.
- The plugin locating a framework's part by path without importing it. Rejected: renders would lose their types.

### The registry, and which frameworks are provided

```ts
// src/framework/registry.ts
import { plugin as claude } from './claude/plugin/index.ts';
/** Every framework this AgentForge provides, by its name in a project's record. */
export const FRAMEWORK_PLUGINS = { claude } as const satisfies Record<FrameworkName, FrameworkPlugin>;
```

`FRAMEWORK_NAMES = ['claude'] as const` and `FrameworkNameEnum` live in `core/contract/framework.ts`. They are the one list of provided frameworks, read by the run record, sync and the registry's `satisfies`. The generator's static `schema.json` carries the same enum, and a unit test pins it to `FRAMEWORK_NAMES`. The Strands stub is not provided, so it is not in the list. Its `name` is typed by the interface as `string`, and it never writes a record.

### The framework interface, in `server/harness/framework.ts`

```ts
/** What a framework fixes for its procedures' types. */
export interface FrameworkTypes {
  readonly content: unknown;   // prompt content beyond the shared ContextContent
  readonly options: object;    // a run's own options
  readonly extras: object;     // spec fields of the framework's own, e.g. memoryDirectory
  readonly usage: unknown;     // the framework's raw usage result
}

export type AgentRunSpec<F extends FrameworkTypes, Output> = {
  readonly prompt: Prompt<F['content']>;      // shared prompt shape over the framework's content
  readonly output: z.ZodType<Output>;
  readonly wrapNonObjectOutput?: boolean;
  readonly options?: F['options'];
  readonly guardrails?: { readonly stop?: readonly StopGuard[] };
} & F['extras'];

export interface AgentRun<F extends FrameworkTypes, Output> {
  readonly output: Output;
  readonly sessionId: string;
  readonly usage: RunUsage;        // shared token usage: a run that answered reached the model
  readonly rawUsage: F['usage'];
  readonly record: RunRecord;
}

export interface RunEnvironment {
  readonly signal: AbortSignal;
  readonly onRecord: (record: RunRecord) => void;
}

export interface Framework<F extends FrameworkTypes> {
  readonly name: string;
  /** Called once per task process, before the first run: reads the environment it needs. */
  prepare(): FrameworkRunner<F>;
  /** Appended after the filesystem mount: context.filesystems → context.agentOptions. */
  readonly agentOptionsMiddleware: AgentOptionsMiddleware<F['options']>;
}

/** The shared prompt shape; a framework widens it with its own content. */
export type PromptContent<Content> = string | ContextBlock | Content;
export type Prompt<Content> = PromptContent<Content> | readonly PromptContent<Content>[];

export interface FrameworkRunner<F extends FrameworkTypes> {
  runAgent<Output>(spec: AgentRunSpec<F, Output>, environment: RunEnvironment): Promise<AgentRun<F, Output>>;
}

/** An oRPC middleware over the task context that writes `agentOptions`. */
export type AgentOptionsMiddleware<Options> = Middleware<
  TaskContext<FrameworkTypes>, { readonly agentOptions: Readonly<Partial<Options>> }>;
```

**Generic over the framework.** `TaskContext<F>` becomes generic: its `runAgent` takes `AgentRunSpec<F, Output>`, and its `agentOptions` is `Readonly<Partial<F['options']>>`. The shared `implementAgent(framework, contract)`, `executeProcedure` and `runTaskProcess({ framework, contract, router })` take the framework. `Output` stays a method generic over fixed `FrameworkTypes`, which avoids higher-kinded spec types.

**The generic forms are internal.** `/agent` exports none of them, nor the interface types: a framework is written inside the package, and a consumer only ever uses one bound to its framework. So each name has one public home. `executeProcedure`, which only the package's tests call, leaves `/agent` with them.

**`ExecuteOptions` loses `sessionStore` and `query`.** `task-process.ts` stops importing the SDK and stops calling `sessionStoreFromEnvironment()`: `claude`'s `prepare()` reads the session store from the environment, and its runner holds `query`. The task-process tests pass a test framework instead of a scripted `query`; the kernel tests keep scripting `query` through `claude`'s runner.

**Also moving with the adapter:** `core/__fixtures__/session-store-conformance.ts`, to `framework/claude/core/__fixtures__/`.

**Extracted first.** `TaskFailure`, `TaskCanceled` (out of `kernel.ts`) and `StopGuard` with `StopGuardDenial` (out of `structured-output-validation.ts`) move to `server/harness/task-failure.ts` and `server/harness/stop-guard.ts` before the Claude files move. `task-process.ts`'s outcome mapping depends on them.

**`/claude/agent` binds the shared pieces,** so a consumer never passes the framework:

```ts
// framework/claude/harness/index.ts
export type ClaudeTypes = { content: ContentBlock; options: AgentOptions; extras: { memoryDirectory?: string }; usage: ModelUsage };
export const framework: Framework<ClaudeTypes>;   // the generic name every framework's entry exports
export const implementAgent = <C extends RouterContract>(contract: C) => sharedImplementAgent(framework, contract);
export const runTaskProcess = (o: { contract: RouterContract; router: Router<TaskContext<ClaudeTypes>> }) =>
  sharedRunTaskProcess({ framework, ...o });
export type TaskContext = SharedTaskContext<ClaudeTypes>;
export type AgentRunSpec<Output> = SharedAgentRunSpec<ClaudeTypes, Output>;
export type AgentRun<Output> = SharedAgentRun<ClaudeTypes, Output>;
export type PromptContent = SharedPromptContent<ContentBlock | CommandBlock>;
export type AgentPrompt = Prompt<ContentBlock | CommandBlock>;
export type ContextContent = SharedContextContent | ContentBlock;
export type ContextBlockFunction<Input extends object = Record<never, never>> = SharedContextBlockFunction<Input, ContentBlock>;
export { runAgent, composeOptions, type AgentOptions, type ContentBlock, type CommandBlock, type ContextDocument,
  documentBlock, distill, type DistillSpec, type DistillDocument, DEFAULT_DISTILL_CAP_TOKENS };
```

`runAgent`, the kernel's free function that `/agent` exports today, moves with the kernel to `/claude/agent`. `/claude/server` also exports its part as `framework`, per "generated seams use generic names", and an importer aliases them.

A procedure in a `claude` project imports `implementAgent` and its types from `/claude/agent`, and the shared pieces from `/agent`: `filesystems`, `S3Filesystem`, `composeContext`, `ContextBlock`, `StopGuard`, `TaskFailure`. A wrong pairing fails to compile, because `TaskContext<ClaudeTypes>` and `TaskContext<StrandsTypes>` differ.

Alternatives weighed:
- `/agent` stays Claude and other frameworks take subpaths. Rejected as asymmetric.
- `implementAgent(contract, framework)` in consumer code. Rejected: it repeats the binding in every procedure module.
- Re-exporting the shared surface from each framework. Rejected: it gives one symbol two homes.

### Shared prompt pieces carry no framework type

- **The cache breakpoint is AgentForge's own type.** The shared `ContextBlock`'s is `type CacheBreakpoint = boolean | { readonly ttl: '5m' | '1h' }`, defined in `server/harness/prompt.ts`. `true` is one hour, as today. The `claude` framework renders it to the Messages API's `cache_control: { type: 'ephemeral', ttl }`, so today's behaviour holds. A consumer that wrote `{ type: 'ephemeral', ttl: '1h' }` writes `{ ttl: '1h' }`.
- **Shared content is narrowed.** The shared `ContextContent` is `string | ContextBlock`. `ContextBlockFunction<Input, Content = never>` returns `readonly (ContextContent | Content)[]`, and `composeContext` is generic over `Content` and passes it through. `/claude/agent` widens both with `ContentBlock`.
- **The Claude prompt types move to `/claude/agent`:** `CommandBlock`, `ContextDocument` and `documentBlock`, with the rendering. A slash command and an inline document are Claude's.

So `/agent` compiles with no Anthropic package installed, as the `harness-framework` spec requires.

### The agentOptions middleware

The registry middleware keeps registering and mounting, and drops `agentOptions`. `runProcedure` appends two middlewares, in order, so both run innermost:

1. the mount middleware;
2. `framework.agentOptionsMiddleware`.

The `claude` framework vends it as an oRPC middleware over a thin util:

```ts
// framework/claude/harness/agent-options.ts
export function toAgentOptions(filesystems: Readonly<Record<string, MountedFilesystem>>): Partial<AgentOptions> {
  const mounts = Object.values(filesystems);
  if (mounts.length === 0) return {};
  return {
    additionalDirectories: mounts.map((m) => m.localPath),
    allowedTools: [...new Set(mounts.flatMap((m) => m.permissions.map(({ action, glob }) =>
      `${action === 'read' ? 'Read' : 'Edit'}(/${m.localPath}/${glob})`)))],   // today's concatenation, verbatim
  };
}
export const agentOptionsMiddleware: AgentOptionsMiddleware<AgentOptions> =
  ({ context, next }) => next({ context: { agentOptions: toAgentOptions(context.filesystems) } });
```

Its output is byte-identical to today's, and the filesystem tests' rule-string assertions become `toAgentOptions`'s. Rejected alternative: filesystem options or meta naming the framework, so the context arrives pre-marshalled. It would make filesystems framework-aware.

### Permissions as data, in `server/harness/filesystem/filesystem.ts`

```ts
export type PermissionAction = 'read' | 'edit';
export interface Permission {
  readonly action: PermissionAction;
  /** Relative to the mount's localPath; `**` for the whole mount. */
  readonly glob: string;
}
export interface MountedFilesystem {
  readonly localPath: string;
  readonly permissions: readonly Permission[];   // read ** first, then edit per write glob
  path(relativePath: string): string;
  writablePath(relativePath: string): string;
}
```

Nothing parses an action, so it stays a type union rather than a Zod enum.

### The run record, in `core/contract/task.ts`

```ts
export const RunUsageSchema = z.strictObject({
  inputTokens: z.number(), outputTokens: z.number(),
  cacheReadInputTokens: z.number(), cacheCreationInputTokens: z.number(),
});
export const RunRecordSchema = z.strictObject({
  framework: z.strictObject({ name: FrameworkNameEnum, fullName: z.string() }),
  promptHash: z.string(), promptBytes: z.number(),
  options: z.record(z.string(), z.unknown()),          // the framework's, as recorded
  sessionId: z.string().optional(),
  transcript: TranscriptLocationSchema.optional(),
  numberOfTurns: z.number().optional(),
  durationMilliseconds: z.number().optional(),
  terminalReason: z.string().optional(),
  usage: RunUsageSchema.optional(),                     // absent only on a run that never reached the model
  rawUsage: z.unknown().optional(),                     // the framework's own result, as reported
  totalCostUsd: z.number().optional(),                  // as today: only where the framework reports it
});
```

- **Mapping.** `claude` maps the SDK result's `usage` into `usage`, `modelUsage` into `rawUsage` (`modelUsage` leaves the record's top level), and `total_cost_usd` into `totalCostUsd`.
- **`fullName`** is `@anthropic-ai/claude-agent-sdk@<version>`. The version is the one AgentForge's published manifest pins (exact, pre-1.0), written into the bundle at build time. So nothing is read at run time, and the image's frozen lock installs that version.
- **Ownership.** `harness-kernel-settlement`'s "every run is recorded" stays the general rule. `harness-framework` owns what the record says of its framework and usage.

### Suggested actions per framework

`SUGGESTED_ACTION_BY_CODE` keeps a framework-neutral text per code:

- `BUDGET_EXHAUSTED`: "Raise the run's turn or spend limit, or narrow what the prompt asks for."
- `USAGE_LIMITED`: "Retry after `retryAfter`, when the provider's usage limit resets."
- `CREDENTIAL_EXPIRED`: "An operator renews the framework's credential and updates the agent's secret; a retry cannot succeed before that."

The `claude` framework's classification passes its own texts through `cause()`'s existing `suggestedAction`: `maxTurns`/`maxBudgetUsd`, the subscription, `claude setup-token`. A `claude` cause's text is therefore unchanged. `core/telemetry.ts`'s level documentation drops "the Claude CLI's" and describes the levels by what they export.

### The server part, secrets and telemetry

```ts
// server/runtime/server.ts — a shape; nothing in framework/ is imported here
export interface FrameworkServer {
  readonly name: string;
  readonly requiredSecrets: readonly string[];
  /** Environment every task process inherits, for this telemetry level. */
  telemetryEnvironment(level: TelemetryLevel, collector: CollectorEndpoint): Readonly<Record<string, string>>;
  /** The collector configuration files per level, in order (`WARN` adds `warn.yaml` today). */
  readonly collectorConfig: Readonly<Record<TelemetryLevel, readonly URL[]>>;
}
export function startServer(options: {
  readonly taskEntry: string | URL;
  readonly framework: FrameworkServer;
  readonly requiredSecrets: readonly string[];   // the layers'; the framework's are added
}): Promise<RunningServer>;
```

- **`/claude/server`** exports `framework: FrameworkServer`. The generated server entry imports it and passes it. The runtime keeps starting the collector and loading secrets, and takes the variables, configs and secret names from what it is given.
- **`core/secrets.ts`** keeps the schema and `SECRETS_VARIABLE`, and loses `REQUIRED_SECRETS`.
- **One source for the framework's secrets.** `framework/claude/core/secrets.ts` defines `REQUIRED_SECRETS = ['CLAUDE_CODE_OAUTH_TOKEN'] as const`. Every place that needs it imports that constant:
  - the server part's `requiredSecrets`;
  - `/claude/infra`, which re-exports it with no export condition, so a CDK app imports it. The generated agent construct types its secrets from it, beside the layers'. `AgentRuntime` takes `requiredSecrets` as a prop and fails synth on a missing one, as it does today for AgentForge's.
  - the plugin part, through which `serve` takes the secrets of the framework the project's record names.

### Entry points

| Subpath | Condition | Holds |
|---|---|---|
| `/agent` | `agentforge-agent` | shared harness surface: `filesystems`, `Filesystem`, `S3Filesystem`, `ScratchFilesystem`, `FilesystemUnsynced` and their types; `composeContext`, `ContextBlock`, `ContextBlockFunction`, `ContextContent`, `CacheBreakpoint`; `StopGuard`, `StopGuardDenial`; `TaskFailure`, `TaskCanceled` |
| `/server` | `agentforge-agent` | `startServer`, `FrameworkServer`, and, as today, `createTaskTable` and `DynamoDBTaskStore` |
| `/claude/agent` | `agentforge-agent` | `framework`, the bound `implementAgent`, `runTaskProcess` and `TaskContext`, `runAgent`, Claude run and prompt types (`AgentPrompt`, `PromptContent`, `ContentBlock`, `CommandBlock`, `ContextDocument`, and the widened `ContextContent` and `ContextBlockFunction`), `composeOptions`, `documentBlock`, `distill` and its types |
| `/claude/server` | `agentforge-agent` | `framework` |
| `/claude/client` | none | `readTranscript` |
| `/claude/infra` | none | `REQUIRED_SECRETS` |

- `/client`, `/contract`, `/temporal`, `/temporal/workflow` and `/infra` are unchanged, except that `/client` loses `readTranscript`. `grantReadTranscripts` stays in `/infra`: it grants the session bucket, whatever reads it.
- `package-exports.test.ts` asserts each subpath, and that `/agent`, `/client` and `/contract` resolve and typecheck with neither Anthropic package installed.
- The stub is reachable from no subpath.

### Images

- **Base** (`libs/agentforge/Dockerfile`, `agentforge/a2a`):
  - Bun slim
  - the collector
  - `s7cmd`
  - `ca-certificates`
  - the non-root `bun` user
  - `/workspace` with the bundle as the `agentforge` member, and `container/`'s root manifest and lock. They carry the runtime's and shared harness's peers: express, the A2A SDK, the AWS clients, oRPC, Zod, `ts-deepmerge`, `ohash`.
- **Framework** (`framework/claude/Dockerfile`, `agentforge/a2a-claude`), `FROM` `BASE_IMAGE` as every layer is:
  - bash, git and ripgrep;
  - `SHELL` and `WORKDIR /workspace/agentic/agent`;
  - the framework's `container/` root manifest and lock.

  **The framework layer extends the workspace's root; it is not a member.** Its manifest is the base's root manifest plus the framework's peers (both Anthropic SDKs, which bring the CLI binary), with the same member globs. The image copies the manifest and its lock over `/workspace/package.json` and `/workspace/bun.lock` and installs frozen. So the bundle's `framework/claude` code at `/workspace/agentforge` resolves the SDKs from the root's `node_modules` exactly as today. The agentic layer's lock is seeded from the framework's.
- **Nx, in the package:**
  - `container-lock-claude`, beside today's `container-lock` (`container/base-lock.ts`), writes the framework's root lock, seeded from the base's. Both locks ship in the bundle, so a consumer never writes them.
  - `image` builds the base as `agentforge/a2a:local`; `image-claude` builds `agentforge/a2a-claude:local` on it. `integ` depends on `image-claude`, so `integ/aws/__fixtures__/agentforge-base-image.ts` keeps naming `agentforge/a2a-claude:local`, and `integ/local/package-tarball` removes both of its consumer tags.
- **Nx, in a consumer's project:**
  - `image-agentforge` builds the base.
  - `image-agentforge-claude` builds the framework image on it.
  - The agentic `image` depends on the framework image, and its `BASE_IMAGE` is that image's tag, as `agentforgeImage(version)` passes today's.

  Today `isAgentTarget` excludes only `image-agentforge`, and `agentOfLayer` throws on a layer it does not know. `image-agentforge-<framework>` would therefore read as an agent's target, so both functions learn each provided framework's layer explicitly. The `agent` generator refuses the names `agentforge` and `agentforge-<framework>`, so no agent's targets collide with them. `images.ts`'s `Layer` gains `agentforge-<framework>`, and it names both tags.
- **Packaging.** `tsdown.config.ts` gains an entry per new subpath, and copies `framework/claude/Dockerfile`, `framework/claude/container/`'s manifest and lock, and the collector configs from `framework/claude/server/collector/`, beside the base's, so a consumer builds both images from the installed package.

### The plugin's record

- **Dependencies.** `init`, which runs before any project names a framework, declares only the shared container peers. `workspace-dependencies.ts` builds them from the base's root dependencies. `agentic-project` adds the framework's own peers, taken from its plugin part, when it generates a project for that framework. So a workspace with no `claude` project never declares the Anthropic SDKs.
- **The record.** The project's `metadata.agentforge` gains `framework`. `agentic-project` takes `--framework`, whose schema enum is `FRAMEWORK_NAMES` with `claude` as the default. An unknown value is refused by the schema before anything is written.
- **Sync** refuses a record that names no framework, or one not in `FRAMEWORK_PLUGINS`, naming the field and the provided frameworks. It writes nothing for that project. This was chosen over back-filling `claude`, which would be a default over missing data and legacy support; the migration entry tells the consumer to add the field.
- **Rendering** reads the framework's plugin part from the registry:
  - the scaffolds
  - the base options
  - the container peers
  - the task entry's and server entry's imports (`runTaskProcess` from `/claude/agent`, `framework` from `/claude/server`)
  - the construct's secret import from `/claude/infra`
  - the Dockerfile path
  - the layers' configuration-directory lines, which `layers.ts` renders as `COPY …$claude/ … .claude/` today
  - the required secrets `serve` passes

```ts
// plugin/framework-plugin.ts — a shape; the registry's values satisfy it
export interface FrameworkPlugin {
  readonly scaffolds: URL;                                   // the procedure and base-layer templates
  readonly baseOptions: Readonly<Record<string, unknown>>;   // the base layer's run options, rendered into it
  readonly containerPeers: Readonly<Record<string, string>>; // added to the workspace by agentic-project
  readonly imports: { readonly taskEntry: string; readonly serverEntry: string; readonly infra: string };
  readonly dockerfile: string;                               // relative to the installed package
  readonly configurationDirectory: { readonly source: string; readonly target: string };  // $claude → .claude
  readonly requiredSecrets: readonly string[];
}
```

### The Strands stub

`framework/strands/harness/index.ts` declares `StrandsTypes`, whose `content`, `options` and `usage` are placeholder types of its own, never `unknown` where `claude`'s is concrete. It exports `strands: Framework<StrandsTypes>`, whose `prepare` and `agentOptions` throw `new Error('the strands framework is not implemented')`.

- It is typechecked by the package's `typecheck`.
- It is in no registry, export or `bundle` entry.
- It has no test, because the typecheck is its check (no placeholder tests).

### `readTranscript`

`client/transcript.ts` moves to `framework/claude/client/transcript.ts`, exported from `/claude/client` with no condition, so a worker or test imports it as before. `smoke-coverage`'s local e2e changes only its import, and keeps asserting that the recorded transcript location reads back (§REQ601).

## Error handling

Within one version, nothing new can fail at run time. Across versions, the run record's shape changes, and a strict parse fails both ways: an older agent's task read by a newer client, and the reverse. So a consumer's callers and agents upgrade together (Migration Plan), which "no legacy support" accepts while no consumer is live. The new failure points all fail before work:

| Failure | When | Outcome |
|---|---|---|
| A shared module imports a framework (other than `plugin/` → the registry), a framework imports another, or an Anthropic SDK is imported outside `framework/claude` | lint | build fails |
| A procedure uses another framework's types | typecheck | build fails |
| `--framework` names a framework not provided | generation | refused by the schema; nothing written |
| A project's record names no framework, or one not provided | sync, and any render | fails naming the field and the provided frameworks; nothing written for it |
| A framework's required secret is unset | the server's first request, as today | that request and every later one fail, naming it |
| The construct is given no framework secret | compile, and synth | fails naming it, as today |
| The stub is wired in by mistake | its first call | throws "not implemented" → `EXECUTION_ERROR` |

Every `claude` run failure keeps its cause, its retryability and its suggested action text.

## Testing

- **Nothing here earns a new integration test.** No platform behaviour is newly relied on; the change is structure. The answer that could drift is the Agent SDK's, and its slices in `integ/model/` stay as they are.
- **Regression:**
  - the package's `test`, including the moved kernel, filesystem and prompt tests;
  - `integ` `local` (which builds the image chain from the packed archive), `aws` and `model`;
  - `golden-kata` and `smoke-coverage` `e2e` locally;
  - `smoke-coverage` `e2e-agentcore` once, since the image chain changes;
  - `golden-kata-workflows` `e2e` locally.
- **Unit tests added:**
  - `toAgentOptions` renders today's strings;
  - the cache breakpoint renders today's `cache_control`;
  - the run record carries `framework`, `usage` and `rawUsage`;
  - a `claude` cause keeps its Claude text, and a neutral `cause()` gets the neutral one;
  - `agentic-project` refuses an unknown framework and records `claude` by default;
  - sync refuses a record with no framework, or an unprovided one;
  - the package-exports test for the new subpaths and for the shared ones resolving without the SDKs.
- **An image check:** inside `agentforge/a2a-claude`, the bundle's `framework/claude` imports the SDK, and the `claude` CLI runs as `bun`. Inside `agentforge/a2a`, neither Anthropic package resolves.
- **Settled once, in a sentence, not a test:** the framework boundary, by lint and typecheck; the stub, by typecheck.

## Risks / Trade-offs

- **[Risk] The interface is shaped by Claude despite the stub.** A stub can satisfy any interface that is permissive enough. → Mitigation: the stub's own concrete types. `strands-framework` is expected to reshape the interface where it must, and the seam is one folder each side.
- **[Risk] An image chain one level longer** costs build time and one more lock. → Mitigation: Nx caches each level, and the base changes only with AgentForge's version.
- **[Trade-off] Two import paths per procedure,** `/agent` and `/claude/agent`. This was accepted over one symbol with two homes.
- **[Risk] A consumer misses the migration.** → Mitigation: sync refuses the project naming the missing field, and a stale import fails to compile.

## Migration Plan

1. AgentForge lands the move, with examples migrated in the same change, verified as in Testing.
2. `references/migrations.md` gains an entry. A consumer:
   - adds `"framework": "claude"` to each agentic project's `metadata.agentforge`;
   - runs `nx sync`, which re-renders the task and server entries, the constructs and the images;
   - moves its procedure imports to `/claude/agent` plus `/agent`;
   - replaces any use of `MountedFilesystem.permissions.allow` with `context.agentOptions` or the new permissions;
   - rewrites a `{ type: 'ephemeral', ttl }` cache breakpoint as `{ ttl }`. A `{ type: 'ephemeral' }` with no `ttl` meant five minutes, which fails a `claude` run before Claude Code's one-hour breakpoints, so it is written `true`;
   - imports `readTranscript` from `/claude/client`, and `runAgent` from `/claude/agent`;
   - upgrades its callers (workers, clients) and redeploys its agents together, since a task of one version does not parse in a client of the other.
3. StrategyFoundry follows it for `rnd`. Its one procedure needs the record field and the import move.

Rollback is the previous package version. No stored record is migrated: task records expire in seven days, and a record without `framework` is from an older version.

## ADRs

- [ADR 0021](../../../adr/0021-an-agentic-project-chooses-its-framework.md), proposed: the framework per project, its folder, its image, the registry, and building the whole seam now.
- These are mutated in place under the rule in `adr/README.md`. The operator ruled on 2026-10-22, recorded in ADR 0021, that StrategyFoundry, bootstrapped locally and not yet customised, does not yet depend on them:
  - [ADR 0018](../../../adr/0018-the-agentforge-image-is-debian.md): bash, git and ripgrep move to the `claude` framework image; the base keeps Debian slim and `ca-certificates`.
  - [ADR 0001](../../../adr/0001-four-layers-with-contracts-at-the-boundaries.md): layer 4 is the project's framework's agent SDK.
  - [ADR 0008](../../../adr/0008-code-ships-in-the-image.md): the base carries AgentForge and the runtime; a framework image carries what its SDK needs.
  - [ADR 0015](../../../adr/0015-filesystems-mount-around-a-procedure.md): a mount's permissions are data, and the framework renders the run options.
