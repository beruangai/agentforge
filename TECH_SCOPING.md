# AgentForge Technical Scoping

## Technical Direction

AgentForge is a monorepo of TypeScript packages that compose workflow orchestration, agent sandboxing, and tool access into a reusable foundation for agentic pipelines.

### Core Architecture

```
Consumer Application
│  Defines: pipelines, prompts, schemas, domain logic
│
├── @beruangai/agentforge-temporal-workflow
│   Activity factories, retry presets, LangSmith helpers
│   Wraps: Temporal SDK (@temporalio/*)
│
├── @beruangai/agentforge-claude-sandbox
│   Container lifecycle, sentinel I/O, session management, credentials
│   Wraps: Docker (dockerode), Agent SDK (@anthropic-ai/claude-code)
│
└── @beruangai/agentforge-mcp-gateway
    HTTP bridge, tool profiles, upstream server management
    Wraps: MCP SDK (@modelcontextprotocol/sdk)
```

All packages share a unified version number. Consumers depend on what they need — the packages are composable, not coupled.

## Key Technical Decisions

### D1: Temporal.io for Workflow Orchestration

**Choice:** Temporal over LangGraph.

**Rationale:**
- Workflow-as-code: pipelines are standard TypeScript functions (`if/else`, `await`, `Promise.all`)
- No state schemas, graph topology, or compiled subgraphs to maintain
- Framework-managed concurrency via worker slot limits and task queues
- Event-sourced durability: completed activities replay from history without re-execution
- Independent child workflows: clean parent-child boundary (args in, result out)
- Heartbeat-based liveness detection for long-running container tasks
- Fully MIT licensed, battle-tested (Uber, Netflix, Stripe)
- Single-binary dev server with zero dependencies

**Trade-off:** No native LLM observability. LangSmith trace integration requires manual `traceable()` wrappers in activities (~20 lines per activity type). Acceptable because the LangSmith SDK works standalone.

### D2: Docker Sandbox for Agent Isolation

**Choice:** Per-task Docker containers with Agent SDK running inside via a bundled agent-runner process.

**Rationale:**
- Full filesystem, network, and credential isolation per task
- Agent-runner calls SDK `query()` programmatically (not CLI)
- Sentinel-wrapped JSON I/O for reliable structured output extraction
- Config-hash-based container identity for session resumption
- Settings hierarchy via Docker `.claude/` directory mounts
- Pattern proven by nanoclaw (qwibitai/nanoclaw) for container-isolated Claude execution

**Trade-off:** Container overhead per task (~2-5s startup). Acceptable for tasks that run minutes to tens of minutes.

### D3: MCP Gateway for Tool Access

**Choice:** HTTP reverse proxy aggregating multiple MCP servers (local stdio, remote Streamable HTTP) with per-request dynamic tool filtering and unified rate limiting.

**Rationale:**
- Single gateway serves all concurrent containers (vs N×M process count with per-container stdio servers)
- Per-request tool filtering via `X-Tools` header — agents only see the minimal tool set they need, reducing context bloat
- Proxies any MCP transport (local stdio, remote Streamable HTTP)
- Unified rate limiting across all agents (FIFO queue, not errors) — consumers never think about rate limits
- No static profiles or admin UI — single-application, fully-trusted, config-is-code
- Centralized tool call logging

**Trade-off:** Gateway is a single point of failure for tool access. Acceptable at current scale; gateway can be made redundant later if needed.

### D4: Observability via OpenTelemetry + LLM Tracing (LangSmith Default)

**Choice:** Two-layer tracing with provider-swappable LLM layer:
1. **Temporal workflow/activity spans** via standard OpenTelemetry interceptors (`@temporalio/interceptors-opentelemetry`) exporting via OTLP — provider-agnostic
2. **LLM tracing** via provider-specific adapter inside containers — LangSmith (`wrapClaudeAgentSDK`) is the default, but isolated for swappability

**Rationale:**
- Single trace tree from workflow → activity → container → agent SDK turns/tools
- OTel layer is fully provider-agnostic (any OTLP-compatible platform: LangSmith, Langfuse, BrainTrust, Jaeger)
- LangSmith-specific code isolated to 2 files (`trace-env.ts`, `agent-runner/tracing.ts`) — swapping providers is a targeted change, not a refactor
- No separate `agentforge-observability` package yet — extract if/when we support multiple providers simultaneously

**Integration pattern:**
1. Worker configured with OTel interceptors + OTLP exporter (consumer provides endpoint URL and headers)
2. Activity trace context propagated to Docker container via env vars
3. Agent-runner reconstructs parent context via provider adapter (default: LangSmith `RunTree`)
4. Provider adapter wraps SDK calls for LLM-level tracing (default: `wrapClaudeAgentSDK`)

### D5: Bun as Primary Runtime

**Choice:** Bun for development, testing, and local execution. Node.js compatible for production.

**Rationale:** Fast startup, native TypeScript execution, built-in test runner alignment with Nx/vitest workspace.

### D6: Nx Monorepo

**Choice:** Nx workspace with `@aws/nx-plugin` for project scaffolding.

**Rationale:** Proven monorepo tooling. Per-package build/test/lint targets. TypeScript project references. Consistent project structure via generators.

## Package Boundaries

### `@beruangai/agentforge-temporal-workflow`

**Responsibility:** Thin layer between Temporal SDK and agent task execution. Makes it easy to define activities that run agent tasks with proper retry, timeout, heartbeat, and tracing configuration.

**Provides:**
- `createClaudeSandboxActivity()` — activity factory that wraps `SandboxRunner.execute()` with heartbeat, tracing, and output validation
- Retry policy presets (longRunning, standard, quick — different timeout/retry profiles)
- LangSmith integration helpers (`traceable()` wrappers, trace context propagation)
- Type utilities for workflow/activity input/output contracts

**Does NOT provide:**
- Workflow definitions (consumers define their own pipelines)
- State schemas (Temporal has no state schemas)
- Fan-out helpers (native `Promise.all` + `executeChild`)
- Worker bootstrap (consumers configure their own workers)

### `@beruangai/agentforge-claude-sandbox`

**Responsibility:** Docker container lifecycle for executing Claude Agent SDK tasks. Handles container creation, volume mounting, credential injection, I/O protocol, session management.

**Provides:**
- `SandboxRunner` class — execute agent tasks in Docker containers
- Agent-runner process (bundled into base Docker image) — calls SDK `query()` inside container
- Sentinel I/O protocol — reliable structured output extraction
- Config-hash container identity — deterministic naming for session resumption
- Volume resolution — static and dynamic mount configuration
- Credential modes — direct env var or OneCLI proxy injection
- Base Dockerfile — Bun + Agent SDK + clean `.claude/` scope

**Does NOT provide:**
- Orchestration (consumers use Temporal or any workflow engine)
- Prompt building (consumers pass prompts as strings or message blocks)
- Output schema definitions (consumers define their own Zod schemas)

### `@beruangai/agentforge-mcp-gateway`

**Responsibility:** HTTP bridge for MCP tool servers with profile-scoped filtering. Manages upstream stdio server lifecycle, exposes tools via HTTP to containers.

**Provides:**
- Gateway server — HTTP endpoint serving MCP tool requests
- Per-request tool filtering — `X-Tools` header with glob matching, no static profiles
- Unified rate limiting — per-server and per-tool FIFO queuing across all agents
- Upstream management — start/stop stdio MCP servers, health monitoring
- Container integration helpers — generate MCP config for agent containers

**Does NOT provide:**
- Request mutation middleware (keep it simple)
- Custom tool implementations (consumers bring their own tool servers)

## Cross-Cutting Concerns

### Error Handling Strategy

Activities classify errors as retryable or non-retryable:
- **Retryable:** Container startup failure, network timeout, transient API errors
- **Non-retryable:** Schema validation failure, permission denied, invalid configuration
- Temporal's `ApplicationFailure` with `nonRetryableErrorTypes` handles routing

Workflows handle degraded results:
- `try/catch` around activity calls
- Return degraded status with error reason
- Consumer decides what degradation means for their domain

### Configuration Pattern

Library provides execution primitives. Consumers own configuration:
- Activity presets (timeout, retry, model) defined as consumer-side const objects
- Config merge utility for composing presets with task-specific overrides
- No preset registry or profile management in the library

### Testing Strategy

**Heavy testing in AgentForge packages:**
- `temporal-workflow`: Unit tests for activity factory lifecycle, retry behavior, trace propagation. Mock SandboxRunner at execute boundary.
- `claude-sandbox`: Integration tests for container lifecycle, volume mounting, sentinel I/O, env propagation. Real Docker required.
- `mcp-gateway`: Integration tests for HTTP bridge, tool filtering, profile enforcement. Mock upstream servers.

**Lightweight testing in consumers:**
- Mock `createClaudeSandboxActivity()` for pipeline topology testing
- Integration tests with real sandbox on dev/staging
- Trust library for infrastructure correctness

### Security Model

- Containers run as non-root user
- Volume mounts explicitly declared per task (no blanket access)
- Credentials injected via env vars (phase 1) or OneCLI proxy (phase 2)
- `.env` shadow-mounted to `/dev/null` inside containers
- MCP gateway enforces tool profiles per request
- `--dangerously-skip-permissions` inside Docker (container IS the sandbox)

## Constraints

- **TypeScript only** — no Python, Go, or other language SDKs
- **Docker required** — sandbox execution depends on Docker availability
- **Single workflow engine** — Temporal is the only supported orchestrator (new engines = new packages)
- **Single agent runtime** — Claude Agent SDK is the only supported agent (new runtimes = new packages)
- **No multi-tenant** — single operator, single set of credentials
- **Bun-first** — development and CI use Bun; production must be Node.js compatible
