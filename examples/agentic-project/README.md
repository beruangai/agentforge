# agentic-project

AgentForge's second example, in the shape the Nx plugin will generate: one project holding a shared **agentic layer** and the **agents** nested in it, each agent its own image and its own runtime ([ADR 0010](../../adr/0010-agentforge-is-consumed-as-an-nx-plugin.md)). Built by hand first; the plugin's generators are designed from it, and then manage it here. `hello-agent` stays the flat, minimal consumer.

Each layer's `files/` is its member of the container workspace, mirrored at the same relative paths in the image:

| Path | In the image | Is |
|---|---|---|
| `base/files/` | `/workspace/agentic` | `@example/agentic-project`: the house rules, the house options every agent composes, the source file schema, and the house MCP server in `mcp/` |
| `base/files/$claude/` | `/workspace/agentic/.claude` | `CLAUDE.md` and the `house-style` skill, composed into every agent's session from the parent of its cwd |
| `base/Dockerfile` | — | The agentic base image: `FROM agentforge/a2a-claude`, the member and its lock, installed |
| `agents/reviewer/files/` | `/workspace/agentic/agent` | `@example/reviewer-agent`: reviews a file in its task's working directory and returns typed findings |
| `agents/fixer/files/` | `/workspace/agentic/agent` | `@example/fixer-agent`: edits a file in its task's working directory into the house style and returns it |
| `agents/*/files/$claude/` | `/workspace/agentic/agent/.claude` | Each agent's own `.claude/` — the only one a session reads `settings.json` and hooks from; every layer has one |
| `e2e/` | — | Both agents, each in its own container, through the client and a real model |

Three images chain: AgentForge's base, the agentic base, each agent. Every `files/bun.lock` is the whole workspace's lock up to that layer — `lock`, `lock-reviewer` and `lock-fixer` write them, each seeded from its parent's — so each image installs only what its layer adds. Agents import the layer by its package name (`@example/agentic-project/house-options`); in the repo the project's tsconfig `paths` map that name to `base/files`. The working directory is each procedure's choice — here a directory per task under the OS temp directory — added with `additionalDirectories` and guarded by a hook.

```bash
bunx nx run @beruangai/example-agentic-project:e2e
```
