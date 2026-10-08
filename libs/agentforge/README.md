# @beruangai/agentforge

Runs a consumer's procedure as an asynchronous task on Bedrock AgentCore Runtime, or locally in Docker, and returns a typed outcome. One package; each entry point exports only what its environment may load.

| Entry point | For |
|---|---|
| `@beruangai/agentforge/contract` | Anywhere, including a worker — the procedure contract |
| `@beruangai/agentforge/client` | A caller — the A2A client |
| `@beruangai/agentforge/temporal` | A Temporal worker — the activity factory |
| `@beruangai/agentforge/agent` | A consumer's agent build only — the task entry: procedures, the kernel and its stop guards (`StopGuard`), `distill`, filesystems |
| `@beruangai/agentforge/server` | A consumer's agent build only — the server entry |
| `@beruangai/agentforge/infra` | A CDK application — the constructs |

`/agent` and `/server` resolve only under the `agentforge-agent` export condition. An agent build opts in with `--conditions=agentforge-agent` (Bun, Node) and `"customConditions": ["agentforge-agent"]` (TypeScript); any other build fails to resolve them.

## The Nx plugin

`nx add @beruangai/agentforge` runs `init`: an agentic project's dependencies at AgentForge's own peer ranges — in the root catalog when `aws-nx-plugin.config.mts` enables catalogs, otherwise the root manifest — and the plugin's sync attached to its `lock` and `image` tasks.

| Generator | Creates |
|---|---|
| `agentic-project <name> [--directory packages]` | A project with a base layer and no agents, its targets, client and construct |
| `agent --project <project> <name> [--procedure Run]` | An agent in the project, recorded as a component; `base` is reserved |
| `workflow-project <name> [--directory packages]` | A workflow project: a placeholder workflow and activity, a test of the workflow, one worker, no connections; the Temporal packages declared at AgentForge's ranges |
| `connection --project <workflow project> --agenticProject <agentic project>` | The workflow project's workflows call the agentic project's agents, recorded as a component of the workflow project |

Every artifact spanning a project's agents — or a workflow project's connections — is rendered from `metadata.components` in its `project.json`. Remove an agent's or a connection's record and sync drops it from those artifacts; an agent's folder stays.

### What AgentForge owns

**Generic names at the seams.** What AgentForge generates exports the same names in every agent and project — an agent's `contract.ts` exports `contract`; `client.ts` exports `client`, `Client`, `Agent`, `CONTRACTS`, `Inputs`, `Outputs` (each procedure's input and output types, `Inputs['<agent>']['<Procedure>']`), `RUNTIME_CONFIG_KEYS` and `CONTAINER_NAMES`; `project.ts` exports `AgenticProject` and `AgenticProjectProps`; an agent's `agent.ts` exports `Agent`, `AgentProps` and `Secrets` — and whoever imports one names it for its context: `import { client as goldenKataClient } from '@<scope>/golden-kata/client'`. The shared constructs package is the exception a flat `export *` forces: each project's `index.ts` aliases its constructs to the project's names (`GoldenKata`, `GoldenKataWriter`).

**Maintained** — `nx sync` rewrites these to what the installed version renders, and `nx sync:check` fails while any differs:

- `base/Dockerfile`, `agents/<agent>/Dockerfile`
- `agents/<agent>/agent/server.ts`, `agents/<agent>/agent/task.ts`
- `client.ts`
- in the shared constructs, `src/app/agentic-projects/<project>/project.ts`, `src/app/agentic-projects/<project>/agents/<agent>/agent.ts`, and `src/app/agentic-projects/<project>/index.ts`, which exports them under the project's names
- the project's targets: `image-agentforge`, `lock`, `image`, `lock-<agent>`, `image-<agent>`, `serve-<agent>`, `assemble`

**Maintained keys** — only these are rewritten; every other key in the file is yours:

| File | Keys |
|---|---|
| `package.json` | `exports`; `dependencies["@beruangai/agentforge"]` |
| `tsconfig.lib.json` | `agentforge-agent` in `compilerOptions.customConditions`; `compilerOptions.paths["@<scope>/<project>-base/*"]` |
| `base/agentic/package.json`, `agents/<agent>/agent/package.json` | `name`, `type`; the `workspace:*` layers in `dependencies`; the runtime peers in `peerDependencies` |
| shared constructs `package.json` | `dependencies["@beruangai/agentforge"]`; the project's package, `workspace:*` |
| shared constructs `project.json` | `<project>:assemble` in `targets.assemble.dependsOn` |
| shared constructs `src/app/index.ts`, `agentic-projects/index.ts` | the `export *` line for each project's index |

**Scaffolded** — written once when absent, then never touched: `base/agentic/options.ts` and `secrets.ts`, `agents/<agent>/agent/contract.ts`, `procedures.ts` and `secrets.ts`, every `$claude/` file, the project's `tsconfig.json` and the rest of its `tsconfig.lib.json`, and the host `package.json`'s other dependencies.

### Workflow projects

A workflow project is a Temporal caller: its workflows call its connected agents' procedures, `const agents = resolveAgents()` from `agents/workflow.ts`, then `agents.goldenKata.writer.Write(input, { runtimeSessionId })`, typed by their contracts and carrying none of their code. `resolveAgents(options)` sets activity options for a set of calls, over AgentForge's defaults (a minute's heartbeat timeout, a day to close, `WAIT_CANCELLATION_COMPLETED`); a call's third argument sets its own, merged over the set's — `Write(input, { runtimeSessionId }, { startToCloseTimeout: '3 hours' })`. Neither may set `activityId`, which keys the agent's task, or `taskQueue`, since only the project's queue has a worker for its activities. Its one worker runs on Node, polls the task queue `<scope>-<project>`, and deploys through its construct as an ECS service on Temporal Cloud. A contract's output reaches a workflow as JSON, as Temporal's payload converter decodes it — a `Date` or a transformed value arrives as its JSON form, whatever the type says; a contract whose output survives the A2A wire survives this.

**Maintained**: `worker.ts`, `client.ts` (`TASK_QUEUE`, `connectClient`), `agents/activities.ts` and `agents/workflow.ts` (one entry per connection), `container/Dockerfile`; in the shared constructs, `src/app/workflow-projects/<project>/project.ts` (`WorkflowProject`, `WorkflowProjectProps`, `Secrets`, requiring each connected project's construct and granting invocation of exactly its agents) and its `index.ts`; the targets `bundle-workflows`, `lock` (writes `container/bun.lock`), `bundle` (the worker and its image's build context under `dist/<project>/bundle`), `assemble`, `temporal-server`, `serve` (`local`, `hybrid`) and `test`.

**Maintained keys**:

| File | Keys |
|---|---|
| `package.json` | `exports["./client"]`, `exports["./secrets"]`; `dependencies`: AgentForge, the `@temporalio/*` packages, each connected project `workspace:*` and no other agentic project |
| `tsconfig.lib.json` | `compilerOptions.paths["@<scope>/<agentic project>-base/*"]` for each connected project, and no other |
| `container/package.json` | `name`, `private`, `type`, `dependencies`: the Temporal packages the worker bundle leaves external, at the workspace's versions |
| shared constructs `package.json`, `project.json`, `src/app/index.ts`, `workflow-projects/index.ts` | as for an agentic project |

**Scaffolded**: `workflows/index.ts` (the bundle's entry), `workflows/example.ts` and `example.test.ts`, `activities/index.ts` (the project's own activities), `secrets.ts`, `vitest.unit.mts`, the project's `tsconfig.json` and the rest of its `tsconfig.lib.json`, and the host `package.json`'s other keys.

**The environment the worker reads**, failing at start and naming each that is unset or wrong: `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE`; `TEMPORAL_API_KEY` for Temporal Cloud, never with a local address; `AGENTFORGE_AGENTS` — `local`, or `runtime-config:<applicationId>`; and each secret `secrets.ts` declares. No connection profile file is read. Locally, `temporal-server` starts the Temporal server every project on the machine shares — a docker-compose stack AgentForge ships, PostgreSQL and Elasticsearch in named volumes — unless it is running, and registers `TEMPORAL_NAMESPACE` on it (address `localhost:7233`, UI `http://localhost:8233`); any target may depend on it, through the `@beruangai/agentforge:temporal-server` executor. `temporal-server-stop` stops it and keeps its data. `serve` runs the worker against it — `serve:local` with the agents in local containers, `serve:hybrid` with the agents on AgentCore from `.env.hybrid.local`.

### Detaching

To own a maintained file or target, name it in the project's `project.json`:

```jsonc
"metadata": {
  "agentforge": {
    "detached": {
      "files": ["packages/my-project/agents/writer/Dockerfile"],   // workspace-relative
      "targets": ["serve-writer"]
    }
  }
}
```

Sync then leaves it as you wrote it, and its updates are yours. Sync fails on an entry that names nothing maintained. Extend an image in its layer's `package.json` first; detach a `Dockerfile` only for what a manifest cannot say.

**System packages and native libraries** are what a manifest cannot say. The AgentForge image is Debian (glibc), so a library published prebuilt only for glibc installs without building from source. Detach the layer's `Dockerfile` — the base layer's for what every agent in the project shares, an agent's for what only it needs — and, before the layer's own `COPY` lines so it is cached across their changes, switch to `USER root`, install, and end on `USER bun`: the CLI refuses unattended tools as root, and a detached file is yours, so staying non-root is yours to keep. Install Python packages into a venv, since Debian's system Python is externally managed, and put it on `PATH` with `ENV`, which the server, every task and the CLI's Bash tool inherit. [`smoke-coverage`](../../packages/examples/smoke-coverage/base/Dockerfile)'s base layer does this for Python and NautilusTrader.
