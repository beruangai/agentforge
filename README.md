# AgentForge

Production-grade TypeScript library for building agentic workflows with Temporal orchestration, Docker-sandboxed Claude Agent SDK execution, and MCP tool access.

## Packages

| Package | Description |
|---------|-------------|
| [`@beruangai/agentforge-temporal-workflow`](./packages/temporal-workflow) | Activity factories, retry presets, and LangSmith helpers for Temporal workflows |
| [`@beruangai/agentforge-claude-sandbox`](./packages/claude-sandbox) | Docker container lifecycle for isolated Claude Agent SDK task execution |
| [`@beruangai/agentforge-mcp-gateway`](./packages/mcp-gateway) | HTTP MCP gateway with profile-scoped tool filtering |

## Quick Start

```bash
# Install dependencies
bun install

# Build all packages
bun run build

# Run tests
bunx nx run-many --target test

# Build specific package
bunx nx build @beruangai/agentforge-temporal-workflow
```

## Architecture

```
Consumer Application
│
├── @beruangai/agentforge-temporal-workflow
│   Temporal SDK wrapper: activity factories, retry, tracing
│
├── @beruangai/agentforge-claude-sandbox
│   Docker sandbox: container lifecycle, sentinel I/O, sessions
│
└── @beruangai/agentforge-mcp-gateway
    Tool gateway: HTTP bridge, profiles, upstream management
```

See [SOLUTION_SPACE.md](./SOLUTION_SPACE.md) for business context and [TECH_SCOPING.md](./TECH_SCOPING.md) for technical direction.

## Development

Built with [Nx](https://nx.dev) workspace and [Bun](https://bun.sh) runtime.

```bash
# Lint all packages
bun run lint

# Test specific package
bunx nx test @beruangai/agentforge-claude-sandbox

# Build with skip lint
bun run build:skip-lint
```

## License

MIT
