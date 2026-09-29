# Design

Guidance, not prescription: adapt to actual constraints. The decisions this design implements are recorded in [ADR 0010](../../../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md) (the plugin, the project as what a caller connects to, the ownership contract, infrastructure left to the consumer) and [ADR 0008](../../../adr/0008-code-ships-in-the-image.md) (the ARN registered in the runtime configuration); their rejected alternatives are there.

## Context

See proposal.md for why. Written against `libs/agentforge`, after `move-package-to-libs`. What exists:

- `examples/agentic-project`, hand-built: a base layer and two agents, each layer a member of the container workspace with its own committed lock, chained by Nx `lock` and `image` targets. Those targets call the package's `container/workspace-lock.ts` and read its `bundle` output by relative path; the AgentForge image is `@beruangai/agentforge:image`; its e2e starts each container through `examples/__fixtures__/local-agent.ts` and builds each agent's client by hand; nothing resolves a deployed agent; its agents reach the base layer through a tsconfig `paths` alias.
- `container-lock` depends on `bundle` today: `base-lock.ts` uses the bundle's published `package.json` as the `agentforge` member, which `tsdown`'s `writePublishedManifest` hook writes.
- `@aws/nx-plugin` 1.0.3 is installed. Its public `sdk/*` exports expose `sharedConstructsGenerator`, `tsProjectGenerator` and `tsInfraGenerator`, `formatFilesInSubtree`, GritQL helpers and `createTreeUsingTsSolutionSetup`.
  - It places shared constructs at `packages/common/constructs` (constants, not options), with `RuntimeConfig` in `src/core/`: a stage singleton whose namespaces become AppConfig configuration profiles in environment `default`, with `grantReadAppConfig` (read of the whole application) and `appConfigApplicationId`, and a `RuntimeConfigApplicationId` output.
  - Its agents register as `rc.set('agentcore', 'agentRuntimes', { ...existing, <Key>: { arn } })`; its generated reader uses Powertools' `getAppConfig`.
  - It records generated projects as `metadata.generator` and their parts as `metadata.components[]` (`{ generator, name, path, …extra }`), and assigns ports against `metadata.ports`.
  - `ts#agent` generates an agent's construct in the shared constructs project but never connects it to an infra project; the consumer declares it in the stack `ts#infra` generated.
- Nx 23 loads a workspace project as a local plugin when the plugin's package does not resolve from the workspace root, registering its TypeScript transpiler (`resolveLocalNxPlugin`). `@beruangai/agentforge` is not in the root `node_modules`, so in this repository the plugin runs from source.
- `ScratchFilesystem` (ADR 0015) gives a task an empty directory of its own, removed when the task ends; `context.filesystemPermissions` carries its allow rules, which a run applies under `permissionMode: 'dontAsk'`.

## Goals / Non-Goals

**Goals:** one component record per agent from which every spanning artifact is derived; one client per project; per-agent constructs and a project construct; an ownership contract a consumer can read and override per artifact; `golden-kata` generated and verified locally and on AgentCore.

**Non-Goals:** inferred targets (`createNodesV2`) — written targets are visible, detachable one by one, and what `@aws/nx-plugin` does; a generated test tier; more than one agentic project per image (the container workspace holds one project's base layer and one agent).

## Public API

```ts
// @beruangai/agentforge/client — additions
/** A transport to a local container, found by name: its published port is resolved on each call. */
function localContainerTransport(containerName: string): Transport;

interface RuntimeConfigSource {
  readonly applicationId: string;   // the deployment's RuntimeConfigApplicationId
  readonly environment?: string;    // default 'default', as @aws/nx-plugin deploys it
  readonly region?: string;
}
/** Reads namespace `agentcore` once; one agentCoreTransport per agent, by its runtime-configuration key. */
function agentCoreTransportsFromRuntimeConfig<Agent extends string>(
  keys: Readonly<Record<Agent, string>>,
  source: RuntimeConfigSource,
): Promise<Record<Agent, Transport>>;
```

```ts
// generators.json — @beruangai/agentforge:<id>
interface InitSchema {}
interface AgenticProjectSchema { name: string; directory?: string }   // directory defaults to 'packages'
interface AgentSchema {
  project: string; name: string;
  procedure?: string;                                                 // the stub procedure's PascalCase name; default 'Run'
}
// hidden: '@beruangai/agentforge:sync'

// executors.json — each reads its project's metadata
interface LockExecutorOptions  { layer: 'base' | `agents/${string}` }
interface ImageExecutorOptions { layer: 'agentforge' | 'base' | `agents/${string}` }
interface ServeExecutorOptions { agent: string }                      // continuous
```

```jsonc
// project.json of an agentic project — the record everything spanning agents is derived from
"metadata": {
  "generator": "@beruangai/agentforge:agentic-project",
  "components": [
    { "generator": "@beruangai/agentforge:agent", "name": "writer", "path": "agents/writer",
      "runtimeConfigKey": "GoldenKataWriter", "containerName": "beruangai-golden-kata-writer" }
  ],
  "agentforge": { "detached": { "files": [], "targets": [] } }      // workspace-relative paths; target names
}
```

Generated and maintained:

```ts
// <project>/client.ts — exported as @<scope>/<project>/client; composes createClient per agent
export const GOLDEN_KATA_CONTRACTS = { writer, grader };
export const GOLDEN_KATA_RUNTIME_CONFIG_KEYS = { writer: 'GoldenKataWriter', grader: 'GoldenKataGrader' } as const;
export const GOLDEN_KATA_CONTAINER_NAMES = { writer: 'beruangai-golden-kata-writer', grader: 'beruangai-golden-kata-grader' } as const;
export type GoldenKataAgent = keyof typeof GOLDEN_KATA_CONTRACTS;
export type GoldenKataClient = { readonly [Agent in GoldenKataAgent]: AgentForgeClient<(typeof GOLDEN_KATA_CONTRACTS)[Agent]> };
export const goldenKataClient: {
  withTransports(transports: Record<GoldenKataAgent, Transport>): GoldenKataClient;
  local(): GoldenKataClient;                                          // localContainerTransport per container name
  fromRuntimeConfig(source: RuntimeConfigSource): Promise<GoldenKataClient>;
};

// packages/common/constructs/src/app/agents/golden-kata-writer/golden-kata-writer.ts
export class GoldenKataWriter extends AgentRuntime {                  // registers itself in the runtime configuration
  constructor(scope: Construct, id: string, props?: Omit<AgentRuntimeProps, 'agentRuntimeArtifact'>);
}

// packages/common/constructs/src/app/agentic-projects/golden-kata/golden-kata.ts
export interface GoldenKataProps {
  readonly agents?: { readonly [Agent in GoldenKataAgent]?: Omit<AgentRuntimeProps, 'agentRuntimeArtifact'> };
}
export class GoldenKata extends Construct {
  readonly agents: { readonly writer: GoldenKataWriter; readonly grader: GoldenKataGrader };
  readonly runtimeConfigApplicationId: string;
  constructor(scope: Construct, id: string, props?: GoldenKataProps);
  /** Invocation of exactly this project's agents, and read of the stage's runtime configuration. */
  grantInvoke(grantee: IGrantable): void;
}
```

A caller: `const kata = await goldenKataClient.fromRuntimeConfig({ applicationId })`, then `kata.writer.Write.SendMessage(…)`, or `procedureActivity(kata.writer.Write, …)` unchanged.

## Decisions

### The plugin is a concept folder of the one package

`libs/agentforge/src/plugin/` holds `generators/`, `executors/` and what they share. The source `package.json` names `generators` and `executors` manifests pointing at source; the published manifest points them at the bundle's JavaScript, as it already strips the source condition. `nx`, `@nx/devkit` and `@aws/nx-plugin` are optional peers (caret: stable).

### An agent is a component, and spanning artifacts are derived from the components

The agent generator appends the component record (deduped by name); every maintained artifact that spans agents — the targets, the project client, the project construct — is rendered from the full list. Adding an agent re-renders them all; a record the consumer removes drops the agent from each on the next sync, while the agent's folder, being the consumer's, stays. `runtimeConfigKey` is `<Project><Agent>` in PascalCase; `containerName` is `<scope>-<project>-<agent>` — both assigned once.

### Local agents are found by container name, on ephemeral ports

`serve-<agent>` runs the agent's container under its `containerName`, publishing port 9000 on an ephemeral host port (`127.0.0.1::9000`), so no port is assigned, recorded or collides. `localContainerTransport(containerName)` resolves the published port with `docker port <name> 9000/tcp` on each call — cheap next to a poll interval, and right again after a restart — and throws naming the container when it is not running, so an absent agent fails loudly (§REQ701), as a missing runtime-configuration key does on AgentCore. A second `serve` of the same agent refuses to start, naming the running container.

### Connection: runtime configuration, one client, one grant

Each agent's construct registers its ARN under namespace `agentcore`, key `agentRuntimes.<runtimeConfigKey>` — the key and shape `@aws/nx-plugin`'s agents use, so one map serves both. The project construct wraps its agents' constructs, passes each agent's props through, exposes the application id, and `grantInvoke` grants `InvokeAgentRuntime` on each agent through `AgentRuntime.grantInvoke` and `RuntimeConfig.grantReadAppConfig` — invocation exact, the read covering the stage's runtime configuration as `@aws/nx-plugin` scopes it. AgentForge's `/infra` is unchanged and knows nothing of `RuntimeConfig`; the generated constructs, beside it in the consumer's shared constructs, join them. Nothing is added to an infra project: the consumer declares the project construct, or single agents' constructs, in its own stack.

`agentCoreTransportsFromRuntimeConfig` uses AppConfig Data (`StartConfigurationSession`, `GetLatestConfiguration`) directly — one small optional peer, imported lazily as `agentCoreTransport` imports its SDK — rather than Powertools' reader, whose cache and transforms AgentForge does not need. The project client composes `createClient` per agent in generated code, where a consumer can read how it works; `/client` gains only what finds a runtime.

### Generated layout, and who owns each artifact

```
<directory>/<name>/                                   agentic project
  project.json  package.json  tsconfig.json  client.ts
  base/Dockerfile
  base/agentic/package.json                           → /workspace/agentic
  base/agentic/$claude/{CLAUDE.md, settings.json, skills/, agents/}
  base/agentic/options.ts                             baseOptions(), composed by every agent
  agents/<agent>/Dockerfile
  agents/<agent>/agent/package.json                   → /workspace/agentic/agent
  agents/<agent>/agent/{server.ts, task.ts, contract.ts, procedures.ts}
  agents/<agent>/agent/$claude/{settings.json, skills/, agents/}
packages/common/constructs/src/app/agents/<name>-<agent>/<name>-<agent>.ts
packages/common/constructs/src/app/agentic-projects/<name>/<name>.ts
```

The contract is only what a generator creates. Files the consumer or a build creates afterwards — the layers' `bun.lock` files, which the `lock` tasks write — are neither; the project record is the consumer's to edit, and generators only append to it.

| Ownership | Artifacts | On sync or regeneration |
|---|---|---|
| **Maintained** | Dockerfiles, `server.ts`, `task.ts`, `client.ts`, the agent and project constructs and their star exports, the project's targets | Rewritten to what the installed version renders from the components |
| **Maintained keys** | A container member's `name`, `type`, `exports` (base layer), its `workspace:*` layers and the peers AgentForge's root provides; the host manifest's AgentForge dependency and its `exports`; `agentforge-agent` in the project's `customConditions`; the shared constructs project's `assemble` edge and its dependency on AgentForge | Those keys rewritten; every other key kept |
| **Scaffolded** | Contracts, procedures, `options.ts`, `$claude/` | Written once when absent; never touched again by anything |
| **Detached** | A maintained file or target named in `metadata.agentforge.detached` | Never touched; the consumer owns its updates |

Dockerfiles stay maintained, though `ARG BASE_IMAGE` means an upgrade rarely changes them, because a layout change in a new AgentForge version must still reach an existing project; scaffolding them would make §REQ704 extension free of a detach at the cost of that. A consumer extends an image in the base layer's manifest first, and detaches a `Dockerfile` only for what a manifest cannot say.

### Sync is the generators' own rendering

Each maintained artifact has one render function; the generators call them, and the sync generator calls them all for every agentic project, reporting each differing, non-detached artifact in `outOfSyncMessage` — which names detaching as the way to keep an edit — and writing it, so regeneration and sync cannot disagree. A `detached` entry naming nothing maintained fails sync, naming it. `init` attaches the sync generator through `targetDefaults` keyed by the plugin's executors (`@beruangai/agentforge:lock`, `:image`), deduped as `@aws/nx-plugin` does, so a stale project is fixed before a lock or image task runs and `nx sync:check` fails in CI.

### Targets

| Target | Executor | Depends on |
|---|---|---|
| `image-agentforge` | `image`, layer `agentforge` | `^bundle` — a no-op for an installed package; in this repository it builds the package first |
| `lock` | `lock`, layer `base` | — |
| `image` | `image`, layer `base` | `lock`, `image-agentforge` |
| `lock-<agent>` | `lock`, layer `agents/<agent>` | `lock` |
| `image-<agent>` | `image`, layer `agents/<agent>` | `lock-<agent>`, `image` |
| `serve-<agent>` | `serve`, continuous, default configuration `serve` | `image-<agent>` |
| `assemble` | aggregate | every `image-<agent>` |

Every `serve-*` target's default configuration is `serve`, so Nx loads `.env.serve` and `.env.serve.local` into it; the subscription token lives there, never in a target. The agent generator adds `<project>:assemble` to the shared constructs project's `assemble`, as `@aws/nx-plugin` does for its agents, so an infra project's `synth` (`^assemble`) builds the images an asset builds `FROM`. Locks are cached on the manifests they read; images are not. Each agentic project owns its `image-agentforge`: a workspace with several projects rebuilds the same tag once per project, which Docker's layer cache makes a near no-op — accepted over a workspace-level owner the plugin would have to create.

### AgentForge's container inputs

The package ships its Dockerfile, the bundle, and the container workspace's root manifest and lock under `container/`. The published-manifest transform moves out of `tsdown.config.ts` into one module that both `bundle` and `container-lock` use; `bundle` depends on `container-lock` and copies `container/workspace/*` into its output, ending the cycle. The executors find these by resolving AgentForge's own package directory: from the published bundle, the package itself; from source in this repository, the `bundle` output, which `image-agentforge`'s `^bundle` edge keeps current. The difference lives only in AgentForge's code; no generated file names a path in `libs/agentforge` or `dist/`.

### Image names, the base argument, and redeploys

The AgentForge image is `agentforge/a2a-claude:<version>`; an agentic image `<scope>/<project>:local`; an agent image `<scope>/<project>-<agent>:local`. Each Dockerfile starts `ARG BASE_IMAGE` / `FROM ${BASE_IMAGE}`, which the `image` executor passes and the agent's construct passes to its asset. The `image` executor writes each image's id to `dist/{projectRoot}/image/<layer>.id`; the agent's construct reads its parent's id as its asset's `extraHash`, so a change below an agent redeploys it, and throws, naming the file and the target that writes it, when it is missing.

### Layers are imported by package name everywhere

The host `package.json` exports the base layer (`"./*": "./base/agentic/*.ts"`), each agent's contract (`"./<agent>": "./agents/<agent>/agent/contract.ts"`) and the client (`"./client"`); the container member of the same name exports the same base modules. An agent imports `@<scope>/<project>/options` and resolves it in the host through the workspace and in the image through the container workspace, with no tsconfig `paths`. The source condition moves to the root `tsconfig.base.json` `customConditions`, where `@aws/nx-plugin`'s preset puts a workspace's own scope, so generated projects carry only `agentforge-agent`. How `golden-kata-infra`'s synth resolves AgentForge at run time in this repository is settled when it is built.

### Dependencies `init` adds

Versions come from AgentForge's own manifest — its peer ranges. They go to the root catalog when `aws-nx-plugin.config.mts` enables catalogs, as `@aws/nx-plugin` does, otherwise to the manifest. Each agentic project depends on `@beruangai/agentforge` (`workspace:*` here, a version in a consumer's).

### `golden-kata`

Generated by `nx g @beruangai/agentforge:agentic-project golden-kata --directory packages/examples`, then `agent writer --procedure Write` and `agent grader --procedure Grade`; its infra with `@aws/nx-plugin`'s `ts#infra` in `packages/examples/golden-kata-infra`, whose hand-written stack declares `GoldenKata` and grants a caller role — the stand-in for the next change's Temporal worker. The README records every command.

What `ts#infra` generates is the consumer's, so the example adapts it in place, as `hello-agent` does today: the stage is `agentforge-example-golden-kata`, so its resources fall under the test role's `agentforge-example-*` patterns; `synth`, `deploy` and a bespoke `destroy` (emptying the versioned buckets first) run as the test role from `.env.integ`, with the throwaway Docker configuration `hello-agent`'s deploy uses; the removal policy is `DESTROY`; `checkov.yml` starts from `hello-agent`'s.

| Layer | Holds |
|---|---|
| `base` | `KataSchema` — a title, a description, the exported function's name and signature, 3–10 cases whose arguments and expected result are JSON text (so the structured-output schema stays closed) — and `CaseResultsSchema`; `runCases(directory)`, which runs `solution.ts` against `kata.json` in a child `bun` with a timeout and compares by deep equality, a case whose JSON does not parse counting as failed; the `kata` MCP server, whose one tool `run_cases` calls it on the directory it is started with; `baseOptions(directory)` — model, `settingSources: ['project']`, the directory as `additionalDirectories`, the MCP server, read tools, `permissionMode: 'dontAsk'`; `CLAUDE.md` naming the kata's files; a `kata-style` skill |
| `writer` | `Write({ topic, difficulty })` with a `ScratchFilesystem` named `kata`: the agent writes `solution.ts` there (adds `Write`, `Edit` and the filesystem's permissions), checks it with `run_cases`, and returns the kata's description, signature and cases; the handler writes `kata.json`, reads `solution.ts` back as `referenceSolution`, and adds `results` from `runCases` — computed, never asked of the model (§REQ102) |
| `grader` | `Grade({ kata })` with a `ScratchFilesystem`: the handler writes `kata.json` and `solution.ts`; the agent, read-only plus `run_cases`, returns one `{ score: 1–5, reasoning }` per fixed rubric criterion — `CLARITY`, `CASE_COVERAGE`, `SOLUTION_CORRECTNESS`, `DIFFICULTY_FIT` — and an overall summary; the handler adds the computed `results` |

Bounded: no loop, a 180-second time budget per procedure, capped turns, Haiku. Isolated: each task's scratch filesystem is its own and removed when it ends; each test uses its own runtime session. The kata travels from writer to grader in the output and the input, not as shared files. The e2e is one suite in two vitest projects differing only in how the client is built (§REQ701): `local` depends on `serve-writer` and `serve-grader` and uses `goldenKataClient.local()`; `agentcore` depends on `deploy` and uses `goldenKataClient.fromRuntimeConfig` with the deployment's application id, as the test role. It asserts only what holds whichever way the model chooses: each output parses against its schema, the grade has exactly one score per rubric criterion, and each `results` equals an independent `runCases` of the returned kata — never that the cases pass.

## Error handling

| Failure | Outcome |
|---|---|
| A generator names a project that is not an agentic project | Throws, naming it; nothing written |
| An agent or procedure name is invalid, or an agent collides with a different existing one | Throws, naming it; a same-name re-run in a synced workspace is a no-op |
| A `detached` entry names nothing maintained | Sync fails, naming the entry |
| A maintained artifact drifted | Sync reports and rewrites it; `sync:check` fails |
| The runtime configuration lacks an agent's key, or its entry has no `arn` | `agentCoreTransportsFromRuntimeConfig` throws, naming the agent and the key — never a partial result |
| AppConfig refuses the read (no grant, wrong application) | Throws with AppConfig's error |
| A local container is not running, or `docker` is absent | `localContainerTransport` throws on the call, naming the container |
| AgentForge's container inputs are missing | The executor throws, naming the path it expected |
| A build fails | The executor fails with the command's output |
| `serve` without `CLAUDE_CODE_OAUTH_TOKEN`, or its container name already running | Fails before starting a container, naming which; on stop it removes its containers and network |
| An agent's construct cannot read its parent image's id | Synth throws, naming the file and the target that writes it |

## Testing

- **`test`**: each generator against `createTreeUsingTsSolutionSetup` — snapshots, a re-run leaving the tree unchanged, a second agent re-rendering the targets, client and constructs, a scaffolded file kept after an edit, a detached artifact untouched and a bad `detached` entry refused, sync reporting and restoring a drifted artifact and dropping a removed component; `localContainerTransport` and `agentCoreTransportsFromRuntimeConfig` against a scripted `docker` and AppConfig Data client, including their failures; each executor's command construction; `golden-kata`'s `runCases`, bespoke.
- **`e2e`**: `golden-kata` locally (A5's exit) and on AgentCore; a template assertion in `golden-kata-infra` that the caller role is granted exactly the two runtimes and the configuration read. `nx sync:check` catches `golden-kata` drifting from what the plugin generates.
- **Settled once, in `docs/research/aws-nx-plugin.md` with its date, not tested**: Nx loading the plugin from source; Docker building from an installed package's directory; the AppConfig deployment being readable once `cdk deploy` returns.

## Risks / Trade-offs

- [The AppConfig deployment completes after the runtime serves, and an immediate read sees the previous version] → `@aws/nx-plugin`'s strategy deploys all at once with no bake; checked once on the first deploy and recorded.
- [Maintained keys in a manifest the consumer also edits] → the keys are few and listed in the package README; everything else in the file is the consumer's.
- [An edit to a maintained artifact is reverted by the next sync] → the out-of-sync message names detaching.
- [`^bundle` on a consumer's agentic project builds any dependency's `bundle` target] → an agentic project depends only on AgentForge and its own layers; accepted.
- [Resolving a local port per call adds a `docker` process per call] → milliseconds against a poll interval of seconds; accepted for correctness across restarts.

## Migration Plan

1. After `move-package-to-libs` lands: the plugin, executors, `init` and the client additions; the `container-lock` reorder and the source condition move with them.
2. `golden-kata` and `golden-kata-infra` are generated, verified locally, then deployed to `us-east-2` as the test role and verified there.
3. `examples/*` leaves the root `workspaces` and is listed in `.nxignore`; `packages/common/*` and `packages/examples/*` join. The existing examples stay on disk as reference; `hello-agent`'s deployed stack stays until its fate is decided.

Rollback is reverting the change and destroying `golden-kata-infra`'s stack.
