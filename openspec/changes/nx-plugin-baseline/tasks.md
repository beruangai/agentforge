# Tasks

Lands after `move-package-to-libs`. Groups 1–6 build the plugin and its client support in `libs/agentforge`; 7 generates and verifies `golden-kata` locally; 8 deploys it. Groups 2, 3 and 6.1 can proceed in parallel once group 1 is done.

## 1. The plugin in the package, and the workspace

- [x] 1.1 `src/plugin/` concept folder with `generators.json` and `executors.json`; the source manifest names them, the published manifest rewrites them to the bundle's JavaScript; `nx`, `@nx/devkit`, `@aws/nx-plugin` as optional caret peers — verified by a placeholder `init` running from source with `nx g @beruangai/agentforge:init --dry-run`, and `bundle` passing `publint --strict` with the manifests, schemas and templates in the bundle
- [x] 1.2 Rewrite `docs/research/aws-nx-plugin.md` as dated evidence: Nx 23 loading the plugin from source (through the root's `workspace:*` dependency, since `resolveLocalNxPlugin` cannot match a package exporting no `.`); `@aws/nx-plugin` 1.0.3's `sdk/*` surface, `RuntimeConfig` and its `agentcore` namespace, component metadata, `ts#agent` leaving infra to the consumer; why the client reads AppConfig Data directly rather than through Powertools — verified by reading it against design.md
- [x] 1.3 The published-manifest transform moves out of `tsdown.config.ts` into one module; `container-lock` builds from it, `bundle` depends on `container-lock` and ships `container/package.json` and `container/bun.lock` — verified by `nx run @beruangai/agentforge:bundle` producing both, and the existing `image` target still building
- [x] 1.4 The source condition moves to the root `tsconfig.base.json` `customConditions` (and the vitest equivalent the unit config needs); root `workspaces` gain `packages/common/*` and `packages/examples/*` and lose `examples/*`; `.nxignore` lists `examples/` — verified by `nx show projects` listing no example, and `nx run-many -t typecheck,test,lint` passing
- [x] 1.5 CLAUDE.md and `.claude/rules/testing.md` place examples and their e2e in `packages/examples/`, and say `examples/` is detached reference; SOLUTION_SPACE and ARCHITECTURE §10 state that resolving a deployment's own agents by name is not agent discovery — verified by `git grep -n "examples/"` over them showing only the new placement or the detached note

## 2. Executors

- [ ] 2.1 AgentForge's container inputs resolved from its own package directory — the package itself when installed, the `bundle` output when running from source — throwing with the expected path when absent — verified by unit tests of both cases and the missing one
- [ ] 2.2 `lock` executor: the logic of `container/workspace-lock.ts` behind a layer option (`base`, `agents/<agent>`), members and seed derived from the project's metadata; `base-lock.ts` and the executor share one module — verified by unit tests of the workspace it assembles, and by locking a scratch layer against the real `bun`
- [ ] 2.3 `image` executor: layers `agentforge`, `base`, `agents/<agent>`; tags `agentforge/a2a-claude:<version>`, `<scope>/<project>:local`, `<scope>/<project>-<agent>:local`; the `BASE_IMAGE` build argument; each image's id written to `dist/{projectRoot}/image/<layer>.id` — verified by unit tests of the commands, and by building the AgentForge image from the bundle
- [ ] 2.4 `serve` executor, continuous: DynamoDB Local and the agent's image on a private network, the agent under its component's container name on an ephemeral host port, the subscription token passed by name from the environment; refuses before starting without the token or with the container already running; removes its containers and network on stop — verified by unit tests of the refusals and the cleanup commands

## 3. The project record, ownership and sync

- [ ] 3.1 The project record as a Zod schema (`metadata.generator`, `components[]` in `@aws/nx-plugin`'s form with `runtimeConfigKey` and `containerName`, `agentforge.detached`), read and written through one module — verified by unit tests of a valid record, an invalid one refused, and appending a component deduped by name
- [ ] 3.2 One render function per maintained artifact and per maintained key set, with the merge that keeps a consumer's other keys; scaffolded artifacts written only when absent — verified by unit tests of a manifest keeping the consumer's keys and a scaffolded file keeping an edit
- [ ] 3.3 The sync generator: renders every agentic project's maintained artifacts, skips detached ones, reports each difference in `outOfSyncMessage` (naming detaching) and writes it; a removed component drops from every spanning artifact; a detachment naming nothing maintained fails — verified by unit tests of each, and of a generator and sync producing the same tree
- [ ] 3.4 The package README lists what is maintained, the maintained keys, what is scaffolded, and how to detach — verified by reading it against the render functions

## 4. `init` and `agentic-project`

- [ ] 4.1 `init`: dependencies at AgentForge's own peer ranges, to the catalog when `aws-nx-plugin.config.mts` enables catalogs and to the manifest otherwise; the sync generator attached through `targetDefaults` keyed by `@beruangai/agentforge:lock` and `:image`, deduped — verified by unit tests of both dependency paths and a re-run changing nothing
- [ ] 4.2 `agentic-project`: the host `package.json` (AgentForge dependency, the base layer's exports), `tsconfig.json` (`agentforge-agent`), `base/Dockerfile` (`ARG BASE_IMAGE`), `base/agentic/package.json`, the scaffolded `options.ts` and `$claude/` placeholders, the targets `image-agentforge` (`^bundle`), `lock`, `image`, `assemble`, and `metadata.generator` — verified by snapshot, a re-run leaving the tree unchanged, and a collision refused

## 5. `agent`

- [ ] 5.1 The component record and the agent's folder: `runtimeConfigKey` `<Project><Agent>`, `containerName` `<scope>-<project>-<agent>`; `agents/<agent>/agent/` with maintained `server.ts`, `task.ts`, `package.json` keys and scaffolded `contract.ts` (one stub procedure, `--procedure`, default `Run`), `procedures.ts` (its handler throwing `not implemented: <agent>.<Procedure>`), `$claude/`; `agents/<agent>/Dockerfile`; the contract exported by the host package — verified by snapshot, a re-run changing nothing, and an unknown project or invalid name refused
- [ ] 5.2 The agent's targets `lock-<agent>`, `image-<agent>`, `serve-<agent>` (default configuration `serve`) and `assemble`'s edge, re-rendered from the components — verified by snapshot of one agent, a second agent adding its targets, and a removed record dropping them

## 6. Connection

- [x] 6.1 `/client`: `localContainerTransport` (the published port resolved per call; a stopped container or absent `docker` failing, naming the container) and `agentCoreTransportsFromRuntimeConfig` over AppConfig Data (`@aws-sdk/client-appconfigdata` an optional peer, imported lazily, in the catalog); the package-exports test updated — verified by unit tests against a scripted `docker` and a scripted AppConfig Data client: every agent resolved, a missing key or `arn` failing with no transports, a refused read surfacing AppConfig's error
- [ ] 6.2 The project's `client.ts` rendered from the components (`<PROJECT>_CONTRACTS`, `_RUNTIME_CONFIG_KEYS`, `_CONTAINER_NAMES`, the client type, and `withTransports`, `local`, `fromRuntimeConfig` composing `createClient` per agent), exported as `./client` — verified by snapshot, re-rendering on a second agent, and a typecheck that naming an absent agent fails
- [ ] 6.3 `sharedConstructsGenerator` run once; each agent's construct rendered — an `AgentRuntime` from its layer's directory with `BASE_IMAGE` and the parent image's id as `extraHash` (throwing when the id file is absent), registering its ARN under `agentcore.agentRuntimes.<runtimeConfigKey>` — and star-exported; the shared constructs' dependency on AgentForge and `<project>:assemble` edge — verified by snapshot and a re-run changing nothing
- [ ] 6.4 The project construct rendered from the components — wrapping the agents' constructs, per-agent props, `runtimeConfigApplicationId`, `grantInvoke` (each agent's invoke and the configuration read) — and star-exported — verified by snapshot and re-rendering on a second agent
- [ ] 6.5 GLOSSARY: add base layer, agentic image, agent image, AgentForge image, agent component, project client, project construct, maintained, scaffolded, detached; retire base image (as a term), agentic layer, agentic base image; "Example" points at `packages/examples/` — verified by reading it against the specs

## 7. `golden-kata`, locally

- [ ] 7.1 Generate it: `init`, `agentic-project golden-kata --directory packages/examples`, `agent writer --procedure Write`, `agent grader --procedure Grade`; the commands recorded in its README — verified by `nx sync:check` passing and re-running every command leaving no diff
- [ ] 7.2 Fetch the current Agent SDK docs for MCP servers, skills and permissions and record what was verified, dated, in `docs/research/claude-agent-sdk.md`; then the base layer: `KataSchema`, `CaseResultsSchema`, `runCases`, the `kata` MCP server's `run_cases`, `baseOptions`, `CLAUDE.md`, the `kata-style` skill — verified by a bespoke unit test of `runCases` passing, failing, an unparsable case, a throwing solution and a timeout
- [ ] 7.3 `writer.Write` and `grader.Grade` as designed, each on a `ScratchFilesystem` with its permissions under `dontAsk`, `results` computed after each run, 180-second budgets — verified by typecheck and lint
- [ ] 7.4 Build the chain — verified by `nx run golden-kata:assemble` building the AgentForge, agentic and both agent images, and no target naming a path in `libs/agentforge` or `dist/`
- [ ] 7.5 The bespoke e2e suite and its `local` project: depends on `serve-writer` and `serve-grader`, builds `goldenKataClient.local()`, the token from `.env.serve.local`; asserts each output parses, one score per rubric criterion, and each `results` equal to an independent `runCases` of the returned kata — verified by it passing against a real model (A5's exit)
- [ ] 7.6 ARCHITECTURE §7–§9 on the plugin, the agentic project, its connection and the examples' place; `golden-kata`'s README — verified by reading them against what was built

## 8. `golden-kata`, on AgentCore

- [ ] 8.1 `ts#infra` in `packages/examples/golden-kata-infra`, adapted: stage `agentforge-example-golden-kata`, `synth`/`deploy` as the test role from `.env.integ` with a throwaway Docker configuration, a bespoke `destroy` emptying the buckets first, `DESTROY` removal, `checkov.yml` from `hello-agent`'s; how its synth resolves AgentForge in this repository settled here; its stack declaring `GoldenKata` with the subscription secret and granting a caller role — verified by `synth` and `checkov` passing
- [ ] 8.2 A template assertion that the caller role may invoke exactly the two runtimes and read the stage's runtime configuration — verified by the test passing
- [ ] 8.3 Deploy to `us-east-2` as the test role, after the operator applies the updated test-role policy — verified by `deploy` returning once both runtimes serve; whether the configuration is readable at once recorded in the research note
- [ ] 8.4 The suite's `agentcore` project, building `goldenKataClient.fromRuntimeConfig` from the deployment's `RuntimeConfigApplicationId` — verified by it passing against the deployed runtimes

## 9. Integration

- [ ] 9.1 `nx run-many -t build`, `nx sync:check`, the `integ` `local` configuration, and both `golden-kata` e2e projects pass; ROADMAP A5 and §ODO003 updated to what was delivered, what was dropped (the procedure generator, the generated infra project) and what is pending — verified by the runs and by reading the docs
