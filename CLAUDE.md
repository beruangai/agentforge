# AgentForge Development Guide

## What This Is

AgentForge (`@beruangai/agentforge-*`) is a monorepo of TypeScript packages providing orchestration, sandboxing, and tool-access layers for agentic AI pipelines. It's a shared foundation used by consumer applications.

## Philosophy

Production-grade library for small teams. Solo engineer, real workloads. Fully tested so consumers can trust it — consumers skip pedantic infrastructure testing and focus on business value.

## Development Approach

**Spec-Driven Development**
- Use OpenSpec (`/opsx:propose`) for all changes
- Write specs before implementing
- Keep it focused on what needs to be built now

**Minimal Everything**
- Minimal abstractions — solve current problems
- Minimal API surface — expose what consumers need, nothing more
- No enterprise patterns for prototype-scale problems
- Production-grade: tested, reliable, observable — but not enterprise-grade

**Ask Over Assume**
- When facing ambiguity, ask for clarification before proceeding
- Use `AskUserQuestion` tool to gather requirements or decisions

## Tech Stack

- **Runtime:** Bun (dev/CI), Node.js compatible (production)
- **Language:** TypeScript (latest stable)
- **Monorepo:** Nx workspace with `@aws/nx-plugin`
- **Testing:** Vitest
- **Dependencies:** Latest stable versions

> Bun instead of Node.js throughout. (`bun <cmd>`, `bunx nx <target>`)

## Package Overview

| Package | npm Name | Purpose |
|---------|----------|---------|
| `temporal-workflow` | `@beruangai/agentforge-temporal-workflow` | Activity factories, retry presets, LangSmith helpers for Temporal |
| `claude-sandbox` | `@beruangai/agentforge-claude-sandbox` | Docker container lifecycle for Claude Agent SDK tasks |
| `mcp-gateway` | `@beruangai/agentforge-mcp-gateway` | HTTP MCP gateway with profile-scoped tool filtering |

## Key Architectural Decisions

- **Temporal.io** for workflow orchestration (not LangGraph)
- **Docker sandbox** for agent isolation (per-task containers)
- **Sentinel I/O protocol** for structured output extraction
- **LangSmith SDK** (standalone) for LLM observability
- **MCP gateway** (shared HTTP) for tool access

See `TECH_SCOPING.md` for full rationale and details.

## Code Structure

**Colocate by Concept**
- Group by feature/concern within each package
- ❌ `controllers/`, `services/`, `models/`
- ✅ Feature-oriented organization within `src/`

**Package Independence**
- Each package is independently buildable and testable
- Minimize cross-package dependencies
- `claude-sandbox` has no dependency on `temporal-workflow`
- `mcp-gateway` has no dependency on either

## Testing

This library is the **trusted foundation**. Tests must be thorough:
- Unit tests for all public APIs and edge cases
- Integration tests requiring Docker for sandbox package
- Mock at package boundaries (mock SandboxRunner when testing temporal-workflow)
- Test error paths and degraded scenarios

```bash
# Run all tests
bun test

# Run specific package
bunx nx test @beruangai/agentforge-claude-sandbox

# Run with coverage
bunx nx test @beruangai/agentforge-claude-sandbox -- --coverage
```

## Building

```bash
# Build all packages
bun run build

# Build specific package
bunx nx build @beruangai/agentforge-temporal-workflow
```

## Key Patterns

### Activity Factory (temporal-workflow)
```typescript
const runTask = createClaudeSandboxActivity({
  name: 'my-task',
  runner: sandboxRunner,
  sandbox: (input) => ({
    prompt: buildPrompt(input),
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Bash'],
  }),
  heartbeatInterval: 15_000,
  timeout: 300_000,
});
```

### Sandbox Execution (claude-sandbox)
```typescript
const result = await runner.execute({
  input: { prompt, model, outputFormat, allowedTools },
  volumes: { '/host/data': '/workspace/data' },
  env: { LANGSMITH_API_KEY: '...' },
  timeout: 300_000,
});
```

### Sentinel I/O Protocol
```
Container stdout:
---AGENTFORGE_OUTPUT_START---
{"status":"success","structuredOutput":{...}}
---AGENTFORGE_OUTPUT_END---
```

## What Not to Do

- Don't add domain-specific logic (trends, trading, etc.) — this is a generic library
- Don't create abstract base classes or generic interfaces over concrete implementations
- Don't add framework features that only one consumer needs
- Don't build for hypothetical future requirements
- Don't skip tests — this is the trusted foundation
- Don't expose internals in the public API

## Git Commits

- When creating multiline commit messages, use direct multiline strings instead of HEREDOCs.
- Use conventional commits.
