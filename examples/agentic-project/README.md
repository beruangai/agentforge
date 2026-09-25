# agentic-project

AgentForge's second example, in the shape the Nx plugin will generate: one project holding a shared **agentic layer** and the **agents** nested in it, each agent its own image and its own runtime ([ADR 0010](../../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). Built by hand first; the plugin's generators are designed from it, and then manage it here. `hello-agent` stays the flat, minimal consumer.

| Path | In the image | Is |
|---|---|---|
| `package.json` | `/agentic/package.json` (generated) | The project's dependencies; `#agentic/*` imports the shared modules |
| `src/` | `/agentic/src` | Shared modules: the house rules, the house options every agent composes, the workspace file schema |
| `mcp/` | `/agentic/mcp` | The house MCP server, run over stdio by every agent |
| `claude/` | `/agentic/claude` | `CLAUDE.md` and the `house-style` skill, loaded through `additionalDirectories` |
| `Dockerfile` | — | The agentic base image: `FROM agentforge/a2a-claude`, the dependencies AgentForge's base lacks installed into `/agentic`, then the layer |
| `image-manifest.ts` | — | The `manifest` task: those dependencies at the catalog's versions, with a frozen lockfile |
| `agents/reviewer/` | `/agentic/agent` | Reviews a file in `/mnt/workspace` and returns typed findings |
| `agents/fixer/` | `/agentic/agent` | Edits a file in `/mnt/workspace` into the house style and returns it |
| `e2e/` | — | Both agents, each in its own container, through the client and a real model |

Three images chain: AgentForge's base (`/node_modules`), the agentic base (`/agentic`), each agent (`/agentic/agent`). An agent resolves its own `node_modules` first, then the project's, then AgentForge's.

```bash
bunx nx run @beruangai/example-agentic-project:e2e
```
