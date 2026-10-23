# Tasks

The groups depend on each other in order:

- Group 1 records the requirement and the documents that change in meaning.
- Groups 2–5 are the package work, in dependency order: the interface and the move, then permissions and options, then the record, causes, secrets and telemetry, then the images.
- Group 6 is the plugin, and needs groups 2–5.
- Group 7 lands everything on the examples and runs the live tiers.
- Group 8 updates the guidance and the remaining documents.

Every group keeps `nx run @beruangai/agentforge:test` and `:typecheck` green.

## 1. Requirements and the documents that change in meaning

- [x] 1.1 `docs/REQUIREMENTS.md` gains §REQ713 in "Building and deploying", as the operator accepts it. `docs/GLOSSARY.md` gains *framework* (the agent SDK a project's runs go through, distinct from layer 2's *harness*), and *kernel*, *agent run*, *AgentForge image*, *agentic image* and *required secrets* are restated for it. Verify by reading each against the proposal.
- [ ] 1.2 `docs/SOLUTION_SPACE.md` drops "Supporting agent frameworks other than the Claude Agent SDK" from out of scope, and its first line names frameworks. `docs/ARCHITECTURE.md` §10 drops "frameworks other than the Claude Agent SDK" from "Deliberately absent". The operator is asked to reword `CLAUDE.md`'s orientation sentence. Verify by reading each against ADR 0021.
- [x] 1.3 ADR 0001 is mutated in place: layer 4 is the project's framework's agent SDK. A dated note says what changed. Verify by reading it against ADR 0021.

## 2. The framework interface and the Claude move

- [x] 2.1 Extract `TaskFailure` and `TaskCanceled` into `server/harness/task-failure.ts`, and `StopGuard` with `StopGuardDenial` into `server/harness/stop-guard.ts`. Re-point their imports. Verify: `test` and `typecheck` pass unchanged.
- [x] 2.2 Add `core/contract/framework.ts` (`FRAMEWORK_NAMES = ['claude']`, `FrameworkNameEnum`) and `server/harness/framework.ts` with the interface and the shared `Prompt` types in design. Verify with `typecheck`.
- [x] 2.3 `TaskContext`, `implementAgent`, `executeProcedure` and `runTaskProcess` become generic over the framework; `ExecuteOptions` loses `sessionStore` and `query`, and `task-process.ts` no longer imports the SDK. Verify with the task-process and registry tests passing a test framework.
- [x] 2.4 Narrow the shared prompt pieces:
  - `CacheBreakpoint` becomes `boolean | { ttl }`, AgentForge's own;
  - the shared `ContextContent` becomes `string | ContextBlock`;
  - `ContextBlockFunction` and `composeContext` become generic over extra content.

  Verify with the prompt tests and the type tests, including a composite carrying a framework's content type.
- [x] 2.5 Move the kernel, prompt rendering (`CommandBlock`, `ContextDocument`, `documentBlock`, rendering a cache breakpoint as `cache_control`) and `structured-output*.ts` into `src/framework/claude/harness/`, with their tests and fixtures, and add the `#framework/*` alias. Re-point the `integ/` slices that import `kernel.ts` and `structured-output.ts`. Verify: the moved tests pass with only import changes, plus a test that a breakpoint renders today's `cache_control`; `integ` typechecks.
- [x] 2.6 Move `system-prompt.ts`, `auto-memory.ts`, `session-store.ts`, `distill.ts` and `options.ts` the same way. Verify: the moved tests pass with only import changes.
- [x] 2.7 Add `framework/claude/core/`: `core/s3-session-store.ts` and its conformance fixture moved into it, `REQUIRED_SECRETS`, and the SDK version the bundle pins. Move `client/transcript.ts` into `framework/claude/client/`, over core's adapter. Verify: the session-store and transcript tests pass.
- [x] 2.8 Implement `framework: Framework<ClaudeTypes>` over the kernel — `prepare()` reads the session store from the environment — and the bound `implementAgent`, `runTaskProcess` and `TaskContext`; `runAgent` and the distill types move to `/claude/agent`. Verify: the kernel tests pass through `framework`'s runner.
- [x] 2.9 Add the Strands stub in `src/framework/strands/harness/`: its own `StrandsTypes`, and `strands: Framework<StrandsTypes>` throwing "the strands framework is not implemented". It is in no registry, export or bundle entry. Verify: `typecheck` passes with no cast, and the `bundle` output contains no stub.
- [x] 2.10 Change the export map and `tsdown.config.ts`'s entries: add `/claude/agent` and `/claude/client`, narrow `/agent` to design's table, and drop `readTranscript` from `/client`. Verify: `package-exports.test.ts` asserts each subpath, and that `/agent`, `/client` and `/contract` resolve and typecheck with neither Anthropic package installed.
- [x] 2.11 Add the `biome.json` rules in design:
  - shared modules ↛ `framework/**`, except `plugin/**` → `framework/registry.ts`;
  - neither framework imports the other;
  - each framework part's restricted groups, per design's table, for `framework/*/{core,harness,server,client,infra,plugin}/**`;
  - the Anthropic SDKs only under `framework/claude/**`, and banned in its `client/` but for `transcript.ts`'s marked exception.

  Remove `core/s3-session-store.ts`'s exception. Verify: `lint` passes, and fails on each kind of violation tried locally and reverted.

## 3. Permissions as data, and options per framework

- [x] 3.1 `MountedFilesystem.permissions` becomes `readonly Permission[]`: `read` on `**`, then `edit` per write glob, relative to the mount. The registry middleware drops `agentOptions`. Verify with filesystem unit tests: the vault example's permissions, and a scope that writes nothing has `read` alone.
- [x] 3.2 Add `claude`'s `toAgentOptions` and its `agentOptions` oRPC middleware. `runProcedure` appends `framework.agentOptions` after the mount middleware. Verify with unit tests asserting today's exact strings for one mount, two mounts and none. The kernel's fenced-read model slice still passes in 7.3.
- [x] 3.3 ADR 0015 is mutated in place: permissions are data, and the framework renders the run options. Verify by reading it against the `filesystem-lifecycle` and `harness-framework` deltas.

## 4. The run record, causes, secrets and telemetry

- [x] 4.1 Change `RunRecordSchema` and `AgentRun` as in design (`framework`, `usage`, `rawUsage`; `modelUsage` leaves the top level). `claude` maps the SDK result into them, and takes `fullName`'s version from the pin in `framework/claude/core/`. Verify with kernel unit tests over a scripted result: the record, and the run the procedure receives; and with a schema test: a record without `totalCostUsd` parses, as one from a framework that reports no cost.
- [x] 4.2 `SUGGESTED_ACTION_BY_CODE` becomes framework-neutral, and `claude`'s classification passes its own texts through `cause()`'s `suggestedAction`. `core/telemetry.ts`'s documentation drops the CLI. Verify with unit tests: a `claude` `CREDENTIAL_EXPIRED`, `USAGE_LIMITED` and `BUDGET_EXHAUSTED` carry today's text, and a bare `cause()` the neutral one.
- [x] 4.3 `REQUIRED_SECRETS` leaves `core/secrets.ts` for `framework/claude/core/`, re-exported from `/claude/infra` with no condition. `AgentRuntime` takes `requiredSecrets` as a prop and fails synth on a missing one. Verify with `agent-runtime.test.ts`: a missing framework secret fails synth, naming it; and `package-exports.test.ts`: `/claude/infra` resolves with no condition.
- [x] 4.4 Add `FrameworkServer` to `server/runtime/server.ts`. `startServer` takes `framework`, adds its required secrets to the layers', and applies its telemetry environment and collector configuration. Move the CLI's variables and `collector/` to `framework/claude/server/`, re-pointing `tsdown.config.ts`'s collector copy, exported from `/claude/server` as `framework`, its `requiredSecrets` from `framework/claude/core/`. Verify with the server and telemetry unit tests over the `claude` server part, with the same environment and configs as today; and `package-exports.test.ts`: `/claude/server` resolves under `agentforge-agent`.

## 5. Images

- [x] 5.1 The current `Dockerfile` becomes the base `agentforge/a2a`, with only the shared lines in design, and `container/`'s root manifest drops the Anthropic SDKs. The package's `image` target builds it as `agentforge/a2a:local`. Verify: `nx run @beruangai/agentforge:image` builds, and neither Anthropic package resolves from `/workspace/agentforge` inside it.
- [x] 5.2 Add `framework/claude/Dockerfile` (`FROM` `BASE_IMAGE`), and its `container/` root manifest (the base's plus the SDKs). Add the package target `container-lock-claude`, beside `container-lock`, which writes the framework's root lock seeded from the base's; both locks, the Dockerfile and the manifest ship in the bundle through `tsdown.config.ts`. Add the package target `image-claude` (`agentforge/a2a-claude:local` on `image`), and make `integ` depend on it; `integ/local/package-tarball` removes both consumer tags. The consumer's `image-agentforge-claude` builds on `image-agentforge`. Verify with `nx run @beruangai/agentforge:image-claude`, and inside `agentforge/a2a-claude`:
  - the bundle's `framework/claude` imports the SDK from `/workspace/agentforge`;
  - the `claude` CLI runs as `bun`;
  - `SHELL` and `WORKDIR` are as today.
- [x] 5.3 ADR 0008 is mutated in place for the framework level, and ADR 0018 for bash, git and ripgrep moving to the `claude` framework image. Verify by reading each against design's Images.

## 6. The plugin

- [x] 6.1 Add `src/framework/registry.ts` and `framework/claude/plugin/`, with the Claude scaffolds, base options, container peers, entry imports, Dockerfile path, the layers' configuration-directory lines and required secrets moved out of the shared plugin artifacts, as design's `FrameworkPlugin`. `init` declares only the shared container peers. Verify: the generators' snapshot tests are unchanged so far, but for `init` no longer declaring the Anthropic SDKs.
- [x] 6.2 `agentic-project` takes `--framework` (`schema.json`'s enum, pinned to `FRAMEWORK_NAMES` by a unit test, defaulting to `claude`), records it in `metadata.agentforge`, and adds the framework's peers from its plugin part. Verify with generator tests: the default record and peers, and an unknown framework refused, naming the provided ones, with nothing written.
- [x] 6.3 Sync refuses a record that names no framework, or an unprovided one, naming the field and the provided frameworks, and writes nothing for that project. Verify with sync tests for both.
- [x] 6.4 Rendering reads the record's framework through the registry:
  - the task entry imports `runTaskProcess` from `/claude/agent`;
  - the server entry passes `framework` from `/claude/server`;
  - the agent construct is typed by `/claude/infra`'s secrets;
  - the layers' configuration-directory lines come from the plugin part.

  Verify with the generators' updated snapshot tests.
- [x] 6.5 The base layer is `FROM` the framework image through `image-agentforge-claude`, which builds on `image-agentforge`. `isAgentTarget` and `agentOfLayer` learn each provided framework's layer, and the `agent` generator refuses the names `agentforge` and `agentforge-<framework>`. Verify with the targets' snapshot tests, and unit tests for both functions and the refused names.
- [x] 6.6 `serve` takes the framework's required secrets from the registry, instead of `core`'s. Verify with the serve executor's tests: a `claude` project's serve requires the subscription token and fails naming it when absent.

## 7. Examples and live verification

- [x] 7.1 Migrate `golden-kata`: add `framework: 'claude'` to the record, run `nx sync`, and move the imports to `/claude/agent` plus `/agent`. Verify: its `test`, `typecheck` and `nx sync:check` pass, and `golden-kata-workflows`' `test` and `nx sync:check` pass unchanged.
- [x] 7.2 Migrate `smoke-coverage` the same way. Its local e2e imports `readTranscript` from `/claude/client`. Verify: `test`, `typecheck` and `nx sync:check` pass.
- [ ] 7.3 Run the live regression: `integ` `local`, `aws` and `model`; `e2e` for `golden-kata`, `smoke-coverage` and `golden-kata-workflows`. Verify: all pass, with results noted in the change.
- [x] 7.4 Run `smoke-coverage` `e2e-agentcore` once, deploying the new image chain. Verify: it passes, and results are noted in the change.

  Results, 2026-10-23:
  - `integ` model: 15/15. `integ` aws: 8 files, 20/20. `integ` local: 9 of 10 files, 38 tests; `package-tarball` waits on the toolchain change, since `@aws/nx-plugin` 1.0.15's preset writes vitest 5.
  - `e2e` local: golden-kata 2/2, smoke-coverage 10/10, golden-kata-workflows 1/1, after the image executor's schema accepted `agentforge-claude`.
  - `e2e-agentcore`: smoke-coverage 10/10. Two notes on one topic, raced, both refused retryably, as `mount-claims.ts` allows. The case now asserts that neither mounts while the other holds, and that a retry mounts once the holder ends.

## 8. Guidance and documents

- [x] 8.1 Update the `claude-plugin` skill and its references for:
  - the imports and `--framework`;
  - permissions as data;
  - the cache breakpoint;
  - `/claude/client`.

  `references/migrations.md` gains the entry in design's migration plan. Verify: the plugin's local integration tests pass, the skill's links resolve, and the entry names every consumer-visible change in the proposal.
- [x] 8.2 Update `docs/ARCHITECTURE.md` §1 (layer 4 and the layout), §3 (procedures and options), §5 (the server's framework part), §6 (the kernel is `claude`'s), §7 (the image chain and the plugin's record) and §8 (entry points, the layout, the client's SDK reach), plus the root and package `README.md`, and `openspec/config.yaml`'s `context`. Verify by reading each against design.md, with no Claude-specific statement left in a shared section.
