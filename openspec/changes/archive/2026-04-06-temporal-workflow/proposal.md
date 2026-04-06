# Proposal: Temporal Workflow Package

## Summary

Implement `@beruangai/agentforge-temporal-workflow` — a thin integration layer between Temporal SDK and agent task execution. The package provides activity factories, retry policy presets, LangSmith tracing helpers, and MCP gateway lifecycle management that make it easy to define Temporal activities wrapping sandboxed agent tasks.

## Problem

Building Temporal activities for agent tasks involves repetitive boilerplate:
- Heartbeat management for long-running container tasks
- LangSmith trace context propagation (activity → container → agent-runner)
- Consistent retry policy configuration across similar task types
- Output validation against structured schemas
- Error classification (retryable vs non-retryable)
- MCP gateway lifecycle (start/stop) and per-activity tool filtering

Each consumer would duplicate this wiring. The patterns are identical across use cases — only the prompts, schemas, and domain logic differ.

## Proposed Solution

A package that provides:

1. **`createClaudeSandboxActivity()`** — Activity factory that wraps `SandboxRunner.execute()` with:
   - Automatic heartbeat intervals (configurable, default 15s)
   - LangSmith `traceable()` wrapping with trace context propagation to containers
   - Output validation via Zod schema (v4+, draft-07)
   - Error classification into Temporal `ApplicationFailure` types
   - MCP gateway integration — accepts tool filter patterns per activity, generates `mcpServers` config automatically via `gateway.mcpServersConfig()`
   - Configurable timeout and retry defaults

2. **Retry policy presets** — Named configurations for common activity duration profiles:
   - `longRunning` — longer timeout (10-15min), more retries, heartbeat required (deep research, complex analysis)
   - `standard` — medium timeout (5-10min), moderate retries (typical agent tasks)
   - `quick` — short timeout (2-5min), fast retry (lightweight tasks, snapshots)
   - Custom presets via factory function

3. **Unified observability** — Temporal workflow tracing + LLM tracing in a single trace hierarchy:
   - **Temporal workflow/activity tracing** via standard OpenTelemetry interceptors (`@temporalio/interceptors-opentelemetry`) exporting via OTLP — provider-agnostic (works with LangSmith, Langfuse, BrainTrust, or any OTLP-compatible platform)
   - **LLM tracing** via LangSmith adapter inside containers — LangSmith is the initial provider; adapter is isolated in `tracing/` module for future swappability without cross-package refactor
   - **`createTracingConfig()`** — configures OTel provider with consumer-provided OTLP endpoint
   - **Bridge helpers**: `getTraceEnvVars()` extracts current trace context as env vars for container propagation
   - Result: workflow → child workflow → activity → container → agent SDK — all unified in one trace tree

4. **MCP gateway management** — Lifecycle management for the shared MCP gateway:
   - Consumers pass a `Gateway` instance to the activity factory
   - Activity factory uses `gateway.mcpServersConfig(tools)` to generate `mcpServers` input for sandbox containers
   - Consumer only specifies tool filter patterns per activity — gateway URL and headers are handled automatically
   - Gateway startup/shutdown is consumer-managed (in worker bootstrap)

5. **Type utilities** — Generic type helpers for activity input/output contracts that work with consumer-defined Zod schemas (v4+, draft-07).

## Non-Goals

- **Workflow definitions**: Consumers define their own Temporal workflow functions. This package doesn't provide workflow templates or abstractions.
- **Worker bootstrap**: Consumers configure their own workers (`Worker.create()`). The package may include a type-safe helper for common worker config but does not own the worker process.
- **Fan-out helpers**: `Promise.all` + `executeChild` is native Temporal. No wrapper needed.
- **State management**: Temporal has no state schemas. Nothing to abstract.
- **Temporal server management**: Consumers deploy their own Temporal infrastructure.
- **Gateway server creation**: Consumers create the `Gateway` instance themselves via `createGateway()` from mcp-gateway and pass it in.

## Consumer Impact

Consumers create a `Gateway` instance and `SandboxRunner`, then use `createClaudeSandboxActivity()` to wrap their agent tasks as activities. Each activity specifies a prompt builder, output schema, tool filter patterns, and retry preset. The factory handles gateway config generation, heartbeat, tracing, and error classification. Pipelines read top-to-bottom as standard TypeScript.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@temporalio/activity` | Activity context (heartbeat) |
| `@temporalio/common` | Shared types (ApplicationFailure) |
| `@temporalio/interceptors-opentelemetry` | Temporal → OpenTelemetry span export |
| `@opentelemetry/sdk-trace-node` | OTel trace provider |
| `@opentelemetry/exporter-trace-otlp-http` | OTLP exporter |
| `@beruangai/agentforge-claude-sandbox` | SandboxRunner for container execution |
| `@beruangai/agentforge-mcp-gateway` | Gateway for MCP tool access from containers |
| `langsmith` | LLM trace bridge (isolated in `tracing/` module) |
| `zod` (v4+) | Output schema validation (draft-07 JSON Schema) |

**Peer dependencies** (consumers provide):
| Package | Purpose |
|---------|---------|
| `@temporalio/workflow` | Workflow definitions |
| `@temporalio/worker` | Worker runtime |

## Risks

- **Temporal SDK stability**: TypeScript SDK is mature but evolving. Pin to specific version range.
- **LangSmith `wrapClaudeAgentSDK` at `langsmith/experimental/anthropic`**: Experimental import path may change. Isolated in `tracing/langsmith-adapter.ts` — single file to update if API changes.
- **Activity factory flexibility**: Must not constrain consumers. Keep the factory thin — if a consumer needs custom behavior, they can use `SandboxRunner` directly.
- **Zod v4**: Requires Zod 4+ for `toJSONSchema()` with `target: 'draft-07'`. Pin minimum version.

## Versioning

All AgentForge packages share a unified version number. A release bumps all packages together.
