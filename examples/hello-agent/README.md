# hello-agent

AgentForge's own agent: the smallest thing a consumer would ship, built and verified the way a consumer's is. If something is awkward here, it is awkward for every consumer — fix it in AgentForge.

`files/` is the agent's member of the container's workspace, copied to `/workspace/agentic/agent` — the agent's cwd.

| File | Is |
|---|---|
| `files/package.json` | The member's manifest: AgentForge from the workspace; zod and oRPC as peers the base image provides |
| `files/$claude/` | The agent's `.claude/`, copied as `/workspace/agentic/agent/.claude`: skills, subagents, and the only `settings.json` and hooks a session reads |
| `files/bun.lock` | The lock of the whole workspace up to this agent, seeded from the base image's; `nx run @beruangai/example-hello-agent:lock` writes it |
| `contract.ts` | The contract callers import: two procedures, one with a declared time budget |
| `procedures.ts` | The implementation: each handler calls `context.runAgent` once |
| `task.ts` | The task entry: the server runs it once per task, in its own process |
| `server.ts` | The container's entry: starts the server and names `task.ts` as its task entry |
| `Dockerfile` | `FROM agentforge/a2a-claude`, plus the member and its lock, installed frozen |
| `infra/app.ts` | The deployment: one `AgentRuntime` serving this directory's image |
| `e2e/` | The whole path against a real model: the client, and the Temporal activity |

```bash
bunx nx run @beruangai/example-hello-agent:e2e
```

That builds AgentForge's bundle, the base image's lock and image, this agent's lock, then this image, runs it beside DynamoDB Local, and drives it through `@beruangai/agentforge/client`. The subscription token comes from `.env.integ.local` and reaches the container by name only. A run costs a few cents.

```bash
bunx nx run @beruangai/example-hello-agent:deploy
```

Deploys the stack `agentforge-example-hello-agent` to `us-east-2` as the test role (`.env.integ`), through the CDK bootstrap roles; it returns once the runtime serves, and writes the runtime's ARN to `dist/examples/hello-agent/deploy/outputs.json`. `destroy` removes it. The target runs `cdk` with an empty throwaway Docker configuration: the asset publish always runs `docker login`, and Docker Desktop's own credential helper would wait on a keychain prompt no one sees. The 12-hour ECR login still lands in the keychain, through `docker-credential-osxkeychain`. Its procedures need the subscription token in the runtime, which is not deployed yet, so a deployed hello-agent serves the protocol but cannot yet run an agent.
