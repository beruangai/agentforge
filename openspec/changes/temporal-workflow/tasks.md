# Tasks: Temporal Workflow Package

## Phase 1: Core Activity Factory

- [ ] Set up package dependencies (`@temporalio/activity`, `@temporalio/common`, `langsmith`, `zod`)
- [ ] Implement `createClaudeSandboxActivity()` factory with basic lifecycle (sandbox call, output return)
- [ ] Add heartbeat management (configurable interval, auto-start/stop)
- [ ] Add output validation via Zod schema (parse, non-retryable error on failure)
- [ ] Add error classification (retryable vs non-retryable `ApplicationFailure` mapping)
- [ ] Write unit tests for activity factory (mock SandboxRunner)
- [ ] Write unit tests for error classification

## Phase 2: Retry Presets

- [ ] Implement retry policy presets (`longRunning`, `standard`, `quick`)
- [ ] Implement `custom()` preset factory
- [ ] Export presets with proper typing for `proxyActivities` usage
- [ ] Write unit tests for preset composition and type compatibility

## Phase 3: Unified Observability (Temporal + LLM Tracing)

- [ ] Add OTel dependencies (`@temporalio/interceptors-opentelemetry`, `@opentelemetry/sdk-trace-node`, `@opentelemetry/exporter-trace-otlp-http`)
- [ ] Implement `createTracingConfig()` — OTel provider, OTLP exporter → LangSmith, Temporal worker sinks/interceptors
- [ ] Implement `getTraceEnvVars()` for activity → container trace context propagation
- [ ] Integrate tracing into `createClaudeSandboxActivity()` (auto-inject trace env vars)
- [ ] Write unit tests for `createTracingConfig()` (correct provider/interceptor setup)
- [ ] Write unit tests for trace env extraction (mock OTel context + RunTree)
- [ ] Write integration test: Temporal workflow span → activity span → container LLM span hierarchy in LangSmith

## Phase 4: Polish & Publish

- [ ] Export all public API from `index.ts`
- [ ] Add JSDoc comments to public API
- [ ] Verify build output (ESM, `.d.ts`)
- [ ] Write package README with usage examples
- [ ] End-to-end test with Temporal `TestWorkflowEnvironment`
