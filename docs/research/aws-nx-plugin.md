# `@aws/nx-plugin` — Conventions Worth Following

Read from the [nx-plugin-for-aws guides](https://awslabs.github.io/nx-plugin-for-aws/en/guides/ts-agent/) on 2026-09-20/21. AgentForge extends these conventions rather than inventing its own ([ADR 0010](../../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). Its own `ts#agent` generator is built for Strands, so the generator is not reusable — the conventions around it are.

## What it does

- **`ts#agent` scaffolds** an agent project: entry point, agent definition, a typed client, and a `Dockerfile` when the infrastructure target is `agentcore-ecr`. Protocol options include A2A, which uses the Strands A2A server on port 9000.
- **Deployment** is either `agentcore` (code packaged as a zip onto a managed runtime) or `agentcore-ecr` (an arm64 image). With ECR, **agents share one workspace-wide asset repository** rather than one repository per agent.
- **Infrastructure** is generated CDK constructs (or Terraform modules) under a common package, exposing `grantInvokeAccess()` for a caller's role.
- **Agent runtime names are CDK- or Terraform-generated.** The construct creates them; a developer does not name them.

## How a caller finds an agent

Three mechanisms, in the plugin's own order of preference:

1. **A construct output** — `agent.agentCoreRuntime.agentRuntimeArn`, and a convenience `agent.invocationUrl`. The ARN has the form `arn:aws:bedrock-agentcore:<region>:<account>:runtime/<agent-runtime-id>`.
2. **AppConfig runtime configuration** — `RUNTIME_CONFIG_APP_ID` names an AppConfig application from which a caller resolves the agent's runtime ARN. Session persistence settings are registered the same way, with the agent's role granted read access for bucket discovery.
3. **An explicit ARN** passed to the client factory: `MyAgentClient.withIamAuth({ agentRuntimeArn })`, alongside `.local()` and `.withJwtAuth()` variants.

## What AgentForge takes from this

- Generated runtime names rather than a name a caller assembles — but not discovery through AppConfig: a caller addresses an agent by the ARN its deployment exports ([ADR 0008](../../adr/0008-code-ships-in-the-image.md)).
- A client factory with a local variant and an IAM-authenticated variant.
- One workspace-wide image registry.
- Constructs granting least-privilege invocation (§REQ708) — AgentForge's is `AgentRuntime.grantInvoke`.


## The workspace preset and its toolchain

**Read and run on 2026-09-23**, `@aws/nx-plugin@1.0.3` with `create-nx-workspace@23.2.1 --pm=bun`, when A0 scaffolded this workspace.

- **The preset writes Biome, not ESLint and Prettier** — one `biome.json` whose only lint rule is `noUndeclaredDependencies`, and per-project `format` and `lint` targets over it. Workspaces are `packages/*`, and versions live in the package manager's **catalog** (bun's top-level `catalog` field) by default.
- **The catalog pins TypeScript `~6.0.3`, not 7.** TypeScript 7.0.2 is the latest stable release, but it ships the native compiler with no classic compiler API — its package exports only `./unstable/*` — and **Nx 23.2.1's project graph fails outright on it** ("Failed to process project graph"), because `@nx/js/typescript` reads tsconfig files through that API. Measured by swapping 7.0.2 into a fresh preset workspace. TypeScript 6 is therefore the latest that works, and moving to 7 waits on Nx.
- **Vitest is 4.1.11, not 5.** `@nx/vitest@23.2.1` declares `vitest: ^3.0.0 || ^4.0.0`.
- **`ts#project` generates** a `compile` target (`tsc --build`), `format` and `lint` over Biome, a vitest config with `environment: 'jsdom'` and `passWithNoTests: true`, and adds a `paths` alias plus an `@<scope>/source` custom condition to `tsconfig.base.json`. AgentForge keeps the Biome targets and drops the rest: one project bundled by tsdown needs no `tsc` emit, tests run in `node`, and a `paths` alias would bypass the package's own export map.
- **Its `ts#sync` generator is not a model for AgentForge's sync generator.** It keeps each project's tsconfig `paths` in step with the base config and declares local workspace dependencies in each `package.json` — workspace hygiene, not keeping a consumer's wiring current with a library version. `ts#agent` was not read at A0: what AgentForge's generators write is §ODO003, deferred until the first agent exists, and reading it now would be reading against no requirement.
- **It generates no `integ` or `e2e` tier.** Those are this repository's (`.claude/rules/testing.md`).
