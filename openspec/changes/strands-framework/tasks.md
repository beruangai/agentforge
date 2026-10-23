# Tasks

The groups depend on each other in order:

- **`framework-seam` is archived first:** this change's deltas cite its `harness-framework` and build on its source.
- **Group 1** is the spike. Any decision it overturns stops the work for the operator.
- **Group 2** records the requirements and ADRs.
- **Groups 3–6** are the package: the framework's core and harness, then its server, infra and image, then the plugin.
- **Group 7** lands the examples and runs the live tiers.
- **Group 8** is guidance and documents.

Every group keeps `nx run @beruangai/agentforge:test`, `:typecheck` and `:lint` green.

## 1. Spike

- [x] 1.1 In a scratch workspace outside the package, run `@strands-agents/sdk` under Bun in a child process, the way a task process runs. Drive an `Agent` on the Anthropic provider to a structured output, and load Cedar's wasm. Verify: both run, or the finding stops the work for the operator.
- [x] 1.1a Settle the SDK's peer set for the provider, storage, Cedar, MCP and telemetry. Find an `@anthropic-ai/sdk` version that serves both the SDK and `claude`'s pinned `0.128.0` in one workspace. Verify: a shared version installs and both frameworks' unit tests pass on it, or the conflict goes to the operator.
- [x] 1.2 Settle storage. Use `S3Storage` sessions against the local store's S3 and against AWS S3 as the test role in `us-east-2`. Resume a session in a second process. Keep memory and an offloaded tool result in the same prefix. Verify: each holds, and each answer is recorded.
- [x] 1.3 Settle structured output under a `BeforeToolCall` hook on `strands_structured_output`. Find whether the hook can refuse with a message the model sees in its turn, how attempts can be counted and capped, and what happens with two submissions in one message. Verify: the behaviour is recorded, and the design's settlement rules hold or are raised with the operator.
- [x] 1.4 Settle cache points. Explicit cache points with automatic placement off; a second run reads the cache. Verify: the cache read tokens are non-zero on the second run.
- [x] 1.5 Settle cancel latency mid-tool, with the task's `AbortSignal`. Verify: it is recorded.
- [x] 1.6 Settle the write scope. A Cedar intervention with a `contextEnricher` refuses a vended file-tool edit outside the write globs, and permits one inside them. Verify: both, or the hook fallback is chosen and recorded.
- [x] 1.7 Settle the layers' directory and instruction file names that Strands' skills plugin and conventions use, and what the vended shell tool needs in the image. Verify: they are recorded, with sources.
- [x] 1.8 Find what the Anthropic API answers when the Console's spend limit is reached: the status, the error `type`, and any field that tells it apart. Verify: a field distinguishes it, or the finding stops the work for the operator (§REQ501).
- [x] 1.9 Write `docs/research/strands-agents.md`, dated, with each finding and its source. Name any seam change the spike shows is needed. Verify by reading it against this design.

  Done 2026-10-23, `docs/research/strands-agents.md`. No decision is overturned. The shared `@anthropic-ai/sdk` is `0.128.0`, outside the SDK's `^0.109.1` peer range but working under Bun on the real API; `strands`' unit tests in group 3 run on it. The seam needs no change.

## 2. Requirements and ADRs

- [x] 2.1 In `docs/REQUIREMENTS.md`, withdraw §REQ705 into "Withdrawn, and reserved" with its reason. Add §REQ714 as ADR 0022 words it, and reword §REQ404 as design.md states. Verify by reading each against the proposal, as the operator accepts them.
- [x] 2.2 Extend ADR 0011 with a dated note: framework storage under the agent's name in the session bucket. It adds to the decision and replaces nothing. Verify by reading it against design.md.
- [x] 2.3 Ask the operator to reword `CLAUDE.md`'s orientation and its subscription premise for §REQ714, and `docs/SOLUTION_SPACE.md`'s authentication assumption. Verify: the operator has the proposed wording.
- [x] 2.4 Bring §ODO005 to the operator. Its trigger, a key beyond the subscription, fires here, so it is deferred with a new trigger or settled. Verify: `docs/DESIGN_OPTIONS.md` records the outcome.

## 3. The framework's core and harness

- [x] 3.1 Add `framework/strands/core/`: `REQUIRED_SECRETS = ['ANTHROPIC_API_KEY']`, and the SDK version the image pins, tested against `package.json`'s peer. Add `@strands-agents/sdk` as a caret optional peer with the peers 1.1a settled, and `strands` to `FRAMEWORK_NAMES`. Verify with unit tests.
- [x] 3.2 Replace the stub's placeholder types with the real `StrandsTypes`, and add `composeOptions`: lists accumulate, and an MCP client named twice throws. Verify with unit tests.
- [x] 3.3 Implement the runner against a scripted Anthropic provider:
  - settlement: the cap, the first accepted submission, every failure in one refusal, a throwing guard;
  - no background work, and fail-closed MCP;
  - the run record and usage.

  Verify with unit tests for each scenario of `framework-strands`'s settlement requirement.
- [x] 3.4 Implement classification over the design's error table, with `strands`' suggested actions. Verify with a unit test per row.
- [x] 3.5 Implement the prompt rendering: `composeContext`'s content to text blocks, a cache breakpoint to a cache point with its TTL, file-backed blocks, and the layers' instructions in order, before AgentForge's fragments. Verify with unit tests.
- [x] 3.6 Implement storage: `S3Storage` under `<agent>/` in the session bucket, from the environment `prepare()` reads; `memorySpace`; offloading; a refused write fails `EXECUTION_ERROR`. Verify with unit tests over a stubbed S3, and an `integ/local/` slice against the local store resuming a session in a second process.
- [x] 3.7 Implement the `agentOptionsMiddleware`: working directories and the Cedar intervention from the mounts' permissions. Verify with unit tests driving the vended file tool inside and outside the write scope.
- [x] 3.8 Implement `distill` for `strands`, with `claude`'s contract. Verify with the distillation unit tests ported to the scripted provider.
- [x] 3.9 Wire `/strands/agent` (bound `implementAgent`, `runTaskProcess` and `TaskContext`) in the export map and `tsdown.config.ts`. Make any seam change the spike named, in shared code and `claude` together. Verify:
  - `package-exports.test.ts` covers the subpath under `agentforge-agent`;
  - `/agent`, `/client` and `/contract` reach no Strands package;
  - the biome rules confine `@strands-agents/*` to `framework/strands/**`, and `framework/strands/**` still imports no Anthropic package.

  Done 2026-10-23. The seam changes: `TranscriptLocation.projectKey` is optional, as `claude`'s alone; the context block's rendering (`renderContextBlock`) and distillation (`distillDocuments`) moved into `server/harness/`, each framework keeping only its own wrapping.

## 4. Server, infra and the image

- [x] 4.1 Add `framework/strands/server/`: `framework: FrameworkServer`, with the OTLP environment per level and `strands`' own collector configuration, copied into the bundle beside `strands/server.js`. Export it from `/strands/server`. Verify with unit tests and `package-exports.test.ts`.
- [x] 4.2 Add `framework/strands/infra/` re-exporting `REQUIRED_SECRETS`, as `/strands/infra` with no condition. Verify: an `AgentRuntime` given `requiredSecrets` from it fails synth without `ANTHROPIC_API_KEY`, naming it.
- [x] 4.2a Add `framework/strands/client/` with `readSession(run)`, loading the SDK and the S3 client only when called, as `/strands/client` with no condition. Verify with a unit test over a stubbed S3, and `package-exports.test.ts`.
- [x] 4.3 Add `framework/strands/Dockerfile` and its `container/` root manifest and lock, `container-lock-strands`, and the `image-strands` target. Ship them in the bundle. Verify with `nx run @beruangai/agentforge:image-strands`: inside it, the bundle's `framework/strands` imports the SDK, and no Anthropic Agent SDK or Claude binary is present.
- [x] 4.4 Add `integ/model/strands-structured-output/` and `integ/model/strands-cache-points/`, and an `integ/aws/` slice for the storage under an agent's role. Verify: they pass.

## 5. The plugin

- [x] 5.1 Add `framework/strands/plugin/` as design.md states, and register `strands` in `FRAMEWORK_PLUGINS`; the schema enum follows `FRAMEWORK_NAMES`. Verify with generator snapshot tests for a `--framework strands` project and agent, and the enum test.
- [x] 5.2 Make `agent`, sync, `serve` and the constructs follow a `strands` project: the base layer `FROM` `agentforge/a2a-strands` through `image-agentforge-strands`; serve requiring `ANTHROPIC_API_KEY`; the construct typed by `/strands/infra`. Verify with unit tests, including a `strands` serve refusing without the key, naming it.
- [x] 5.3 Extend `integ/local/package-tarball` to generate, sync, typecheck and build a `strands` project from the packed archive. Verify: it passes.

## 6. Examples

- [x] 6.1 Generate `strands-smoke` with `--framework strands`, and implement its agent's procedures for a resume in another container, a cancel mid-tool, and a filesystem across containers. Its local e2e reads a run's session back with `readSession`. Verify: `test`, `typecheck` and `nx sync:check` pass.
- [x] 6.2 Generate the realistic non-coding example: a brief from documents in an `S3Filesystem`, a citing stop guard, and a memory space. Verify: `test`, `typecheck` and `nx sync:check` pass.
- [x] 6.3 Add both examples' infra projects, with `ANTHROPIC_API_KEY` as a Secrets Manager secret the operator creates. Verify: `synth` and `checkov` pass.

  Neither example has a `test` target, as `smoke-coverage` has none: they hold no logic of their own to unit-test. `typecheck`, `lint` and `nx sync:check` pass; both infra projects synth, and `checkov` passes 51 of 51. The research-brief AgentCore suite uploads its corpus as the test role, so `test-role-permissions-policy.json` grants `s3:PutObject` on `agentforge-example-research-brief-*/corpora/*`, which the operator applies.

## 7. Live verification

- [ ] 7.1 Run `e2e` for both examples locally against a real model. Verify: they pass, with results noted in the change.
- [ ] 7.2 Run `e2e-agentcore` for both examples once. Verify: they pass, with results noted in the change.
- [ ] 7.3 Rerun the `claude` regression: `integ` `local`, `aws` and `model`, and `e2e` for `golden-kata`, `smoke-coverage` and `golden-kata-workflows`. Verify: they pass unchanged.

## 8. Guidance and documents

- [x] 8.1 Update the `claude-plugin` skill: when to choose `strands`, defining and implementing a `strands` procedure, credentials and the spend limit, and the examples. `references/migrations.md` gains the entry design.md states. Verify: the plugin's local integration tests pass, and its links resolve.
- [ ] 8.2 Update:
  - `docs/ARCHITECTURE.md` §1, §5, §6 (a `strands` runner section beside the kernel, with the fragments rule), §7, and §8 (entry points, the layout line for `src/framework/strands/`, peers);
  - `docs/GLOSSARY.md`, with *memory space* framework-neutral;
  - `docs/SOLUTION_SPACE.md`, as the operator words it;
  - the root and package `README.md`;
  - `openspec/config.yaml`'s `context`.

  Verify by reading each against design.md.
