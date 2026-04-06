# Tasks: Temporal Workflow Package

## Phase 1: Core Activity Factory

- [ ] Set up package dependencies (`@temporalio/activity`, `@temporalio/common`, `@beruangai/agentforge-claude-sandbox`, `@beruangai/agentforge-mcp-gateway`, `langsmith`, `zod` v4+)
- [ ] Define `SandboxActivityConfig` type (composite of `AgentForgeContainerInput` fields + `ExecuteConfig` fields + `tools` filter)
- [ ] Implement `createClaudeSandboxActivity()` factory with basic lifecycle (sandbox call, output return)
- [ ] Add heartbeat management (configurable interval, auto-start/stop)
- [ ] Add gateway integration — `gateway.mcpServersConfig(tools)` generates `mcpServers`, merged into sandbox input
- [ ] Add output validation via Zod schema (v4+, `z.toJSONSchema(schema, { target: 'draft-07' })`, non-retryable error on failure)
- [ ] Add error classification (retryable vs non-retryable `ApplicationFailure` mapping)
- [ ] Write unit tests for activity factory (mock SandboxRunner + Gateway)
- [ ] Write unit tests for gateway integration (mcpServersConfig called with correct tools, merged correctly)
- [ ] Write unit tests for error classification

## Phase 2: Retry Presets

- [ ] Implement retry policy presets (`longRunning`, `standard`, `quick`)
- [ ] Implement `custom()` preset factory
- [ ] Export presets with proper typing for `proxyActivities` usage
- [ ] Write unit tests for preset composition and type compatibility

## Phase 3: Unified Observability (Temporal + LLM Tracing)

- [ ] Add OTel dependencies (`@temporalio/interceptors-opentelemetry`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`)
- [ ] Implement `createTracingConfig()` — OTel provider, OTLP exporter, Temporal worker sinks/interceptors
- [ ] Implement `tracing/langsmith-adapter.ts` — isolated LangSmith-specific trace extraction (`RunTree` headers)
- [ ] Implement `tracing/trace-env.ts` — `getTraceEnvVars()` delegates to langsmith-adapter for env var extraction
- [ ] Integrate tracing into `createClaudeSandboxActivity()` (auto-inject trace env vars)
- [ ] Write unit tests for `createTracingConfig()` (correct provider/interceptor setup, mock OTel)
- [ ] Write unit tests for trace env extraction (mock langsmith-adapter, verify delegation)

## Phase 4: Integration Tests

- [ ] Docker integration test: activity factory → SandboxRunner.execute() → real container (requires Docker, `INTEGRATION=true`)
- [ ] Docker integration test: container → gateway → mock upstream (deferred from mcp-gateway task #32, requires Docker, `INTEGRATION=true`)
- [ ] Temporal `TestWorkflowEnvironment` test with mocked activities (in-memory, no Docker)

## Phase 5: Polish & Publish

- [ ] Export all public API from `index.ts`
- [ ] Add JSDoc comments to public API
- [ ] Verify build output (ESM, `.d.ts`)
- [ ] Write package README with usage examples
