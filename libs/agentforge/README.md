# @beruangai/agentforge

Runs a consumer's procedure as an asynchronous task on Bedrock AgentCore Runtime, or locally in Docker, and returns a typed outcome. One package; each entry point exports only what its environment may load.

| Entry point | For |
|---|---|
| `@beruangai/agentforge/contract` | Anywhere, including a worker — the procedure contract |
| `@beruangai/agentforge/client` | A caller — the A2A client |
| `@beruangai/agentforge/temporal` | A Temporal worker — the activity factory |
| `@beruangai/agentforge/agent` | A consumer's agent build only — the task entry: procedures, the kernel, filesystems |
| `@beruangai/agentforge/server` | A consumer's agent build only — the server entry |
| `@beruangai/agentforge/infra` | A CDK application — the constructs |

`/agent` and `/server` resolve only under the `agentforge-agent` export condition. An agent build opts in with `--conditions=agentforge-agent` (Bun, Node) and `"customConditions": ["agentforge-agent"]` (TypeScript); any other build fails to resolve them.

## The Nx plugin

`nx add @beruangai/agentforge` runs `init`: an agentic project's dependencies at AgentForge's own peer ranges — in the root catalog when `aws-nx-plugin.config.mts` enables catalogs, otherwise the root manifest — and the plugin's sync attached to its `lock` and `image` tasks.

| Generator | Creates |
|---|---|
| `agentic-project <name> [--directory packages]` | A project with a base layer and no agents, its targets, client and construct |
| `agent --project <project> <name> [--procedure Run]` | An agent in the project, recorded as a component; `base` is reserved |

Every artifact spanning a project's agents is rendered from `metadata.components` in its `project.json`. Remove an agent's record and sync drops it from those artifacts; its folder stays.

### What AgentForge owns

**Maintained** — `nx sync` rewrites these to what the installed version renders, and `nx sync:check` fails while any differs:

- `base/Dockerfile`, `agents/<agent>/Dockerfile`
- `agents/<agent>/agent/server.ts`, `agents/<agent>/agent/task.ts`
- `client.ts`
- in the shared constructs, `src/app/agents/<project>-<agent>/<project>-<agent>.ts` and `src/app/agentic-projects/<project>/<project>.ts`
- the project's targets: `image-agentforge`, `lock`, `image`, `lock-<agent>`, `image-<agent>`, `serve-<agent>`, `assemble`

**Maintained keys** — only these are rewritten; every other key in the file is yours:

| File | Keys |
|---|---|
| `package.json` | `exports`; `dependencies["@beruangai/agentforge"]` |
| `tsconfig.json` | `agentforge-agent` in `compilerOptions.customConditions`; `compilerOptions.paths["@<scope>/<project>-base/*"]` |
| `base/agentic/package.json`, `agents/<agent>/agent/package.json` | `name`, `type`; the `workspace:*` layers in `dependencies`; the runtime peers in `peerDependencies` |
| shared constructs `package.json` | `dependencies["@beruangai/agentforge"]` |
| shared constructs `project.json` | `<project>:assemble` in `targets.assemble.dependsOn` |
| shared constructs `src/app/index.ts`, `agents/index.ts`, `agentic-projects/index.ts` | the `export *` line for each construct |

**Scaffolded** — written once when absent, then never touched: `base/agentic/options.ts`, `agents/<agent>/agent/contract.ts` and `procedures.ts`, every `$claude/` file, and the host `package.json`'s other dependencies.

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
