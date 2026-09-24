# hello-agent

AgentForge's own agent: the smallest thing a consumer would ship, built and verified the way a consumer's is. If something is awkward here, it is awkward for every consumer — fix it in AgentForge.

| File | Is |
|---|---|
| `src/contract.ts` | The contract callers import: two procedures, one with a declared time budget |
| `src/procedures.ts` | The implementation: each handler calls `context.runAgent` once |
| `src/task.ts` | The task entry the server runs once per task |
| `src/server.ts` | The container's entry |
| `Dockerfile` | `FROM agentforge/a2a-claude`, dependencies from the workspace lockfile, the published bundle in place of the workspace link |
| `e2e/` | The whole path against a real model: the client, and the Temporal activity |

```bash
bunx nx run @beruangai/example-hello-agent:e2e
```

That builds AgentForge's bundle and base image, then this image, runs it beside DynamoDB Local, and drives it through `@beruangai/agentforge/client`. The subscription token comes from `.env.integ.local` and reaches the container by name only. A run costs a few cents.
