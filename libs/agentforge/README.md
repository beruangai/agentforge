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
