# `@aws/nx-plugin` and Nx — What AgentForge's Plugin Relies On

AgentForge extends `@aws/nx-plugin`'s conventions rather than inventing its own ([ADR 0010](../../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). Each section is dated; the versions are `@aws/nx-plugin@1.0.3` and `nx@23.2.1`, read from the installed packages unless it says otherwise.

## Nx loading AgentForge's plugin from source

**Read and run on 2026-09-30.**

- **Generators resolve through the package, not the project.** `nx g @beruangai/agentforge:<generator>` reads the plugin's `package.json` through `readPluginPackageJson`: first `require.resolve('@beruangai/agentforge/package.json')` from the workspace root, then, on `MODULE_NOT_FOUND`, `resolveLocalNxPlugin`, which matches the import path against the workspace's projects — a tsconfig `paths` alias, or a package whose exports map the bare name. AgentForge's package exports no `.` (every import names its environment), so `resolveLocalNxPlugin` finds nothing (`Unable to find local plugin`), and the lookup fails.
- **The workspace root depends on the package** (`"@beruangai/agentforge": "workspace:*"` in the root `devDependencies`), as `nx add` makes a consumer's root do. Bun links `node_modules/@beruangai/agentforge` to `libs/agentforge`, the source manifest names `./src/plugin/generators.json`, and Nx imports its `.ts` implementations directly: Nx 23 prefers Node's native type stripping (Node 26), registering swc-node or ts-node only when stripping fails. Verified with `nx g @beruangai/agentforge:init --dry-run`.
- **The published manifests load the same way.** `nx g <bundle>/plugin/generators.json:init --dry-run` runs the bundled JavaScript the published `package.json` names.

## The `sdk/*` surface

**Read on 2026-09-30.** Only `sdk/*` is public; everything under `src/utils/` is internal and may move in any release.

- `sdk/ts`: `sharedConstructsGenerator(tree, { iac }, declaration)`, `tsProjectGenerator`, `tsInfraGenerator` and the other TypeScript generators. `sharedConstructsGenerator` creates `packages/common/constructs` (the name `common-constructs` and the directory are constants, not options) once, with `src/core/` — `RuntimeConfig`, `checkov`, `app`, `workspace` — and `src/app/index.ts`, and writes nothing when its `project.json` exists. Its `declaration` must declare `constructs`, `aws-cdk-lib` and `@types/node`, which it adds to that project's manifest.
- `sdk/utils/format`: `formatFilesInSubtree`. `sdk/utils/ast`: `applyGritQL`, `matchGritQL`. `sdk/utils/test`: `createTreeUsingTsSolutionSetup`, a virtual tree laid out as its preset lays out a workspace.
- Not exported: `addComponentGeneratorMetadata`, `addStarExport`, `addDependencyToTargetIfNotPresent`, `mergeTargetDefault`. AgentForge implements the few lines of each it needs rather than importing an internal path.

## Runtime configuration

**Read on 2026-09-30**, from `src/utils/files/common/constructs/src/core/runtime-config.ts.template`.

- `RuntimeConfig.ensure(scope)` is a singleton per stage (or stack). `set(namespace, key, value)` and `get(namespace)` hold plain data; each namespace becomes an AppConfig configuration profile (`AWS.Freeform`, hosted, JSON) in one application with one environment, `default`, deployed with a strategy of zero duration, 100% growth and no bake.
- The AppConfig resources exist only once something asks for them: `appConfigApplicationId` (a lazy token, with a `RuntimeConfigApplicationId` stack output) or `grantReadAppConfig(grantee)` registers the aspect that creates them. `grantReadAppConfig` grants `appconfig:StartConfigurationSession` and `appconfig:GetLatestConfiguration` on `application/<id>/*` — the whole application, every namespace.
- Its agents register under namespace `agentcore`: `rc.set('agentcore', 'agentRuntimes', { ...rc.get('agentcore').agentRuntimes, <ClassName>: { arn, session? } })`, keyed by the construct's class name. AgentForge's agent constructs use the same key and shape, so one map serves both plugins' agents.
- Its generated reader (`agent-connection`'s `runtime-config.ts`) reads the namespace with Powertools' `getAppConfig('agentcore', { application, environment: 'default', transform: 'json' })`.

**Why AgentForge's client reads AppConfig Data directly.** `agentCoreTransportsFromRuntimeConfig` reads the namespace once, when a caller builds its client. Powertools' reader brings a cache, transforms and a provider layer AgentForge does not use, and a second optional peer beside `@aws-sdk/client-appconfigdata`, which it wraps. Two calls — `StartConfigurationSession`, then `GetLatestConfiguration` with its token — are the whole read, and AppConfig's own errors surface unchanged.

## Component metadata, targets and `ts#agent`

**Read on 2026-09-30.**

- A generated project records its generator as `metadata.generator`; each component a generator adds to it is appended to `metadata.components[]` as `{ generator, path, name?, …extra }`, deduped by generator and name, and never rewritten. `ts#agent` records its port the same way and assigns ports against it; AgentForge assigns none (local agents are found by container name).
- `ts#agent` with `agentcore` infrastructure generates the agent's construct in the shared constructs project (`src/app/agents/<name>/<name>.ts`, star-exported from `src/app/agents/index.ts` and `src/app/index.ts`), adds `<project>:build` and `<project>:assemble` to that project's `build` and `assemble`, and connects the construct to no infra project: the consumer declares it in the stack `ts#infra` generated.
- Its construct registers itself in the runtime configuration, grants its own runtime `grantReadAppConfig`, and sets `RUNTIME_CONFIG_APP_ID` in the runtime's environment.
- **Sync generators are attached through `targetDefaults`.** Its `init` adds its sync generators to `targetDefaults.compile.syncGenerators`, filtering its own names out before appending them, so a re-run changes nothing; a `targetDefaults` entry that is an array is merged into its catch-all (unfiltered) entry.

## The workspace preset and its toolchain

**Read and run on 2026-09-23**, `@aws/nx-plugin@1.0.3` with `create-nx-workspace@23.2.1 --pm=bun`, when A0 scaffolded this workspace.

- **The preset writes Biome, not ESLint and Prettier** — one `biome.json` whose only lint rule is `noUndeclaredDependencies`, and per-project `format` and `lint` targets over it. Workspaces are `packages/*`, and versions live in the package manager's **catalog** (bun's top-level `catalog` field) by default, recorded as `packageManager.catalogs` in `aws-nx-plugin.config.mts`.
- **The catalog pins TypeScript `~6.0.3`, not 7.** TypeScript 7.0.2 ships the native compiler with no classic compiler API, and **Nx 23.2.1's project graph fails outright on it** ("Failed to process project graph"), because `@nx/js/typescript` reads tsconfig files through that API. Measured by swapping 7.0.2 into a fresh preset workspace.
- **Vitest is 4.1.11, not 5.** `@nx/vitest@23.2.1` declares `vitest: ^3.0.0 || ^4.0.0`.
- **`ts#project` generates** a `compile` target (`tsc --build`), `format` and `lint` over Biome, a vitest config with `environment: 'jsdom'` and `passWithNoTests: true`, and adds a `paths` alias plus an `@<scope>/source` custom condition to `tsconfig.base.json`. AgentForge keeps the Biome targets and drops the rest: one project bundled by tsdown needs no `tsc` emit, tests run in `node`, and a `paths` alias would bypass the package's own export map.
- **Its `ts#sync` generator is not a model for AgentForge's sync generator.** It keeps each project's tsconfig `paths` in step with the base config — workspace hygiene, not keeping a consumer's wiring current with a library version.
- **It generates no `integ` or `e2e` tier.** Those are this repository's (`.claude/rules/testing.md`).

## What the shared constructs generator assumes, and continuous tasks — observed 2026-09-30

Observed generating `golden-kata` into this repository with `@aws/nx-plugin@1.0.3` and Nx 23.2.1.

- **`sharedConstructsGenerator` assumes the preset's workspace.** It registers the `@nx/js/typescript` and `@nx/vitest` inference plugins, adds `@nx/vitest` and `jsdom`, and writes a vitest config importing `@nx/vite`, which it does not add. Its projects typecheck only under the preset's base — `composite` and `emitDeclarationOnly` (`BASE_TSCONFIG_COMPILER_OPTIONS` in `src/utils/base-tsconfig.js`) — without `verbatimModuleSyntax`, which its generated `core/` code breaks. `@nx/js:typescript-sync` keeps a root reference only to a composite project, and the inferred `typecheck` is disabled for a project whose tsconfig says `noEmit`. It also rewrites `.gitignore`, dropping blank lines, when it adds `runtime-config.json`.
- **A declaration-emitting consumer must be able to name every type an export infers.** An exported router whose type came through `filesystems()` failed with TS2527/TS4023 while AgentForge keyed its registry by a module-private `unique symbol` and interface; a string key and a type alias fixed it.
- **Nx starts a continuous task's dependents once the task has started, not once it is ready** (`startContinuousTask` in `tasks-runner/task-orchestrator.js` schedules the next tasks right after spawning it). An executor yielding success after its own readiness check gates nothing downstream: `golden-kata`'s e2e reached `docker port` before the containers existed, and now waits for each agent's `/ping` itself.
- **Nx runs every sync generator on one shared tree** (`runSyncGenerators` in `utils/sync-generators.js`), so a generator's reported changes include those of the generators before it; the message printed is each generator's own only when it returns one.
