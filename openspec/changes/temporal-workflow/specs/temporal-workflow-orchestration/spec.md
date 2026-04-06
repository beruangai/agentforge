## ADDED Requirements

### Requirement: Create Temporal activities from sandbox execution config
The package SHALL provide a factory function that creates typed Temporal activity functions wrapping `SandboxRunner.execute()`. The factory handles heartbeat management, trace propagation, and output extraction so consumers only specify task-specific configuration.

#### Scenario: Activity executes sandbox task and returns output
- **WHEN** the activity function is called with input
- **THEN** it builds sandbox config from the input, executes via SandboxRunner, and returns the structured output

#### Scenario: Heartbeat sent at configured interval
- **WHEN** a sandbox task is running
- **THEN** Temporal heartbeats are sent at the configured interval (default 15s) until execution completes

#### Scenario: Heartbeat stopped on completion
- **WHEN** the sandbox execution completes (success or failure)
- **THEN** the heartbeat timer is cleared

#### Scenario: Output validated against Zod schema
- **WHEN** an output schema is provided and the sandbox returns structured output
- **THEN** the output is validated against the schema before being returned

#### Scenario: Schema validation failure is non-retryable
- **WHEN** the sandbox output does not match the provided Zod schema
- **THEN** a non-retryable `ApplicationFailure` is thrown with type `SchemaValidationError`

#### Scenario: No output schema skips validation
- **WHEN** no output schema is provided
- **THEN** the structured output is returned as-is without validation

### Requirement: Classify sandbox errors into Temporal failure types
The package SHALL map sandbox execution errors to appropriate Temporal `ApplicationFailure` types, distinguishing retryable from non-retryable failures so Temporal's retry policy handles them correctly.

#### Scenario: Agent task error is retryable
- **WHEN** the sandbox returns status "error" from an agent task failure
- **THEN** a retryable `ApplicationFailure` is thrown

#### Scenario: Container startup failure is retryable
- **WHEN** the sandbox runner fails to start the container (Docker error, network error)
- **THEN** a retryable `ApplicationFailure` is thrown

#### Scenario: Container timeout is retryable
- **WHEN** the sandbox execution exceeds its timeout
- **THEN** a retryable `ApplicationFailure` is thrown

#### Scenario: Schema validation failure is non-retryable
- **WHEN** output validation fails
- **THEN** a non-retryable `ApplicationFailure` is thrown with type `SchemaValidationError`

#### Scenario: Permission denied is non-retryable
- **WHEN** a credential or access error occurs
- **THEN** a non-retryable `ApplicationFailure` is thrown with type `PermissionDenied`

### Requirement: Provide retry policy presets for common activity profiles
The package SHALL export named retry policy configurations that consumers spread into `proxyActivities()` options. Presets cover common activity duration profiles without requiring consumers to manually configure timeouts and retry parameters.

#### Scenario: Long-running preset for extended tasks
- **WHEN** a consumer uses the `longRunning` preset
- **THEN** it provides a start-to-close timeout of 15 minutes, heartbeat timeout of 30 seconds, and up to 3 retry attempts with exponential backoff

#### Scenario: Standard preset for typical tasks
- **WHEN** a consumer uses the `standard` preset
- **THEN** it provides a start-to-close timeout of 10 minutes, heartbeat timeout of 30 seconds, and up to 2 retry attempts

#### Scenario: Quick preset for lightweight tasks
- **WHEN** a consumer uses the `quick` preset
- **THEN** it provides a start-to-close timeout of 5 minutes and up to 2 retry attempts

#### Scenario: Custom preset merges with defaults
- **WHEN** a consumer creates a preset via `custom()` with partial overrides
- **THEN** the overrides are merged with `standard` preset defaults

#### Scenario: Non-retryable error types respected
- **WHEN** a preset is used with Temporal's retry policy
- **THEN** `SchemaValidationError` and `PermissionDenied` are listed as non-retryable error types

### Requirement: Propagate trace context from activities to containers
The package SHALL extract the current trace context inside a Temporal activity and provide it as environment variables for injection into sandbox containers. This enables the container-side agent runner to link its LLM traces as children of the activity span.

#### Scenario: Trace env vars extracted in activity context
- **WHEN** `getTraceEnvVars()` is called inside a running activity
- **THEN** environment variables containing the current trace context are returned

#### Scenario: Trace env vars injected into sandbox execution
- **WHEN** the activity factory executes a sandbox task
- **THEN** trace environment variables are automatically merged into the container's env

#### Scenario: Missing trace context returns empty env
- **WHEN** `getTraceEnvVars()` is called but no trace context is active
- **THEN** an empty object is returned (no error)

### Requirement: Configure OpenTelemetry tracing for Temporal workers
The package SHALL provide a helper that configures an OpenTelemetry trace provider with an OTLP exporter, returning the worker sinks and interceptors needed for Temporal workflow and activity span export.

#### Scenario: Tracing config returns worker configuration
- **WHEN** `createTracingConfig()` is called with an OTLP endpoint and service name
- **THEN** it returns `workerConfig` (sinks + interceptors) ready to spread into `Worker.create()`

#### Scenario: Shutdown flushes pending spans
- **WHEN** `tracing.shutdown()` is called
- **THEN** all pending spans are flushed to the OTLP endpoint before resolving

#### Scenario: Provider-agnostic OTLP configuration
- **WHEN** a consumer provides any OTLP-compatible endpoint (LangSmith, Langfuse, Jaeger, etc.)
- **THEN** spans are exported to that endpoint without provider-specific logic in the configuration
