# Tasks: Temporal Workflow Package

## Phase 1: Core Activity Factory

- [x] Set up package dependencies (`@temporalio/activity`, `@temporalio/common`, `@beruangai/agentforge-claude-sandbox`, `@beruangai/agentforge-mcp-gateway`, `langsmith`, `zod` v4+)
- [x] Define `SandboxActivityConfig` type (composite of `AgentForgeContainerInput` fields + `ExecuteConfig` fields + `tools` filter)
- [x] Implement `createClaudeSandboxActivity()` factory with basic lifecycle (sandbox call, output return)
- [x] Add heartbeat management (configurable interval, auto-start/stop)
- [x] Add gateway integration — `gateway.mcpServersConfig(tools)` generates `mcpServers`, merged into sandbox input
- [x] Add output validation via Zod schema (v4+, `z.toJSONSchema(schema, { target: 'draft-07' })`, non-retryable error on failure)
- [x] Add error classification (retryable vs non-retryable `ApplicationFailure` mapping)
- [x] Write unit tests for activity factory (mock SandboxRunner + Gateway)
- [x] Write unit tests for gateway integration (mcpServersConfig called with correct tools, merged correctly)
- [x] Write unit tests for error classification

## Phase 2: Retry Presets

- [x] Implement retry policy presets (`longRunning`, `standard`, `quick`)
- [x] Implement `custom()` preset factory
- [x] Export presets with proper typing for `proxyActivities` usage
- [x] Write unit tests for preset composition and type compatibility

## Phase 3: Unified Observability (Temporal + LLM Tracing)

- [x] Add OTel dependencies (`@temporalio/interceptors-opentelemetry`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`)
- [x] Implement `createTracingConfig()` — OTel provider, OTLP exporter, Temporal worker sinks/interceptors
- [x] Implement `tracing/langsmith-adapter.ts` — isolated LangSmith-specific trace extraction (`RunTree` headers)
- [x] Implement `tracing/trace-env.ts` — `getTraceEnvVars()` delegates to langsmith-adapter for env var extraction
- [x] Integrate tracing into `createClaudeSandboxActivity()` (auto-inject trace env vars)
- [x] Write unit tests for `createTracingConfig()` (correct provider/interceptor setup, mock OTel)
- [x] Write unit tests for trace env extraction (mock langsmith-adapter, verify delegation)

## Phase 4: Integration Tests

- [x] Docker integration test: activity factory → SandboxRunner.execute() → real container (in `integ/sandbox-activity.test.ts`)
- [x] Docker integration test: container → gateway → mock upstream (in `integ/sandbox-activity.test.ts`)
- [x] Temporal `TestWorkflowEnvironment` test with mocked activities (in-memory, no Docker)

## Phase 5: Polish & Publish

- [x] Export all public API from `index.ts`
- [x] Add JSDoc comments to public API
- [x] Verify build output (ESM, `.d.ts`)
- [x] Write package README with usage examples
