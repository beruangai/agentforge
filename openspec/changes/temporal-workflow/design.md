# Design: Temporal Workflow Package

## Public API

### `createClaudeSandboxActivity()`

Activity factory that wraps `SandboxRunner.execute()` with heartbeat, tracing, and validation.

```typescript
import { createClaudeSandboxActivity } from '@beruangai/agentforge-temporal-workflow';
import { SandboxRunner } from '@beruangai/agentforge-claude-sandbox';
import { z } from 'zod';

const runner = new SandboxRunner();

// Returns a Temporal activity function
const runTask = createClaudeSandboxActivity({
  name: 'my-agent-task',
  runner,

  // Sandbox config builder (receives activity input)
  sandbox: (input: TaskInput) => ({
    prompt: buildPrompt(input),
    model: 'sonnet',
    maxTurns: 30,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch'],
    disallowedTools: ['Write'],
    outputFormat: TaskOutputSchema,
    volumes: {
      [input.dataPath]: '/workspace/data',
      [input.contextPath]: { target: '/workspace/context', readonly: true },
    },
    env: {
      TASK_ID: input.taskId,
    },
    network: 'agentforge-net',
  }),

  // Output validation
  outputSchema: TaskOutputSchema,

  // Heartbeat (default 15s)
  heartbeatInterval: 15_000,

  // Timeout (overrides SandboxRunner default)
  timeout: 300_000,
});
```

### Type Signature

```typescript
interface CreateClaudeSandboxActivityConfig<TInput, TOutput> {
  /** Activity name (used in tracing and logging) */
  name: string;

  /** SandboxRunner instance */
  runner: SandboxRunner;

  /** Build sandbox execution config from activity input */
  sandbox: (input: TInput) => SandboxExecutionConfig;

  /** Zod schema for output validation (optional — skips validation if omitted) */
  outputSchema?: z.ZodType<TOutput>;

  /** Heartbeat interval in ms (default: 15000) */
  heartbeatInterval?: number;

  /** Execution timeout in ms (default: runner's default) */
  timeout?: number;
}

interface SandboxExecutionConfig {
  prompt: string | MessageBlock[];
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  outputFormat?: object;
  volumes?: VolumeMap;
  env?: Record<string, string>;
  network?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  sessionId?: string;
}

// Returns a typed activity function
function createClaudeSandboxActivity<TInput, TOutput>(
  config: CreateClaudeSandboxActivityConfig<TInput, TOutput>
): (input: TInput) => Promise<TOutput>;
```

### Internal Implementation

```typescript
function createClaudeSandboxActivity<TInput, TOutput>(
  config: CreateClaudeSandboxActivityConfig<TInput, TOutput>
): (input: TInput) => Promise<TOutput> {
  const { name, runner, sandbox, outputSchema, heartbeatInterval = 15_000, timeout } = config;

  // Wrap with LangSmith traceable() for LLM-level tracing
  // wrapActivityWithTracing is a thin wrapper around langsmith's traceable()
  // that sets the run name and run_type for the activity span
  return wrapActivityWithTracing(name, async (input: TInput): Promise<TOutput> => {
    // Start heartbeat
    const heartbeatTimer = setInterval(() => heartbeat(), heartbeatInterval);

    try {
      // Get trace env vars for container propagation
      const traceEnv = getTraceEnvVars();

      // Build sandbox config
      const sandboxConfig = sandbox(input);

      // Execute in container
      const result = await runner.execute({
        input: {
          name,
          prompt: sandboxConfig.prompt,
          model: sandboxConfig.model,
          maxTurns: sandboxConfig.maxTurns,
          allowedTools: sandboxConfig.allowedTools,
          disallowedTools: sandboxConfig.disallowedTools,
          outputFormat: outputSchema
            ? toJSONSchema(outputSchema, { target: 'draft-07' })
            : sandboxConfig.outputFormat,
          mcpServers: sandboxConfig.mcpServers,
          sessionId: sandboxConfig.sessionId,
        },
        volumes: sandboxConfig.volumes,
        env: { ...sandboxConfig.env, ...traceEnv },
        timeout,
        network: sandboxConfig.network,
      });

      // Validate output
      if (result.status === 'error') {
        throw new ApplicationFailure(
          result.error ?? 'Agent task failed',
          'AgentTaskError',
          true, // retryable by default
        );
      }

      if (outputSchema) {
        const parsed = outputSchema.safeParse(result.structuredOutput);
        if (!parsed.success) {
          throw ApplicationFailure.nonRetryable(
            `Output validation failed: ${parsed.error.message}`,
            'SchemaValidationError',
          );
        }
        return parsed.data;
      }

      return result.structuredOutput as TOutput;
    } finally {
      clearInterval(heartbeatTimer);
    }
  });
}
```

### Retry Policy Presets

```typescript
import { retryPresets } from '@beruangai/agentforge-temporal-workflow';

// Pre-configured retry policies (generic, not domain-specific)
export const retryPresets = {
  /** Long-running tasks: deep research, complex analysis (10-15min) */
  longRunning: {
    startToCloseTimeout: '15 minutes',
    heartbeatTimeout: '30 seconds',
    retry: {
      initialInterval: '10s',
      backoffCoefficient: 2,
      maximumInterval: '2m',
      maximumAttempts: 3,
      nonRetryableErrorTypes: ['SchemaValidationError', 'PermissionDenied'],
    },
  },

  /** Standard tasks: typical agent work (5-10min) */
  standard: {
    startToCloseTimeout: '10 minutes',
    heartbeatTimeout: '30 seconds',
    retry: {
      initialInterval: '10s',
      backoffCoefficient: 2,
      maximumInterval: '2m',
      maximumAttempts: 2,
      nonRetryableErrorTypes: ['SchemaValidationError', 'PermissionDenied'],
    },
  },

  /** Quick tasks: lightweight, fast-completing work (2-5min) */
  quick: {
    startToCloseTimeout: '5 minutes',
    retry: {
      initialInterval: '5s',
      maximumAttempts: 2,
      nonRetryableErrorTypes: ['SchemaValidationError', 'PermissionDenied'],
    },
  },

  /** Custom: factory for consumer-defined presets */
  custom: (overrides: Partial<RetryPreset>): RetryPreset => ({
    ...retryPresets.standard, // base on standard defaults
    ...overrides,
  }),
} as const;
```

**Usage in consumer workflow:**

```typescript
// Consumer workflow file
const research = proxyActivities<typeof activities>({
  ...retryPresets.longRunning,
});

const analysis = proxyActivities<typeof activities>({
  ...retryPresets.standard,
});

const snapshot = proxyActivities<typeof activities>({
  ...retryPresets.quick,
});
```

### Unified Observability: Temporal + LLM Tracing

Two tracing layers unified in a single trace tree. The tracing integration uses standard OpenTelemetry for Temporal spans and a provider-specific adapter for LLM tracing. LangSmith is the default provider but the coupling is isolated for future swappability.

**Layer 1: Temporal workflow/activity spans** via OpenTelemetry interceptors:

```typescript
import { createTracingConfig } from '@beruangai/agentforge-temporal-workflow';

// Generic OTLP config — works with any OTLP-compatible platform
// LangSmith is the default, but endpoint/headers are consumer-provided
const tracing = createTracingConfig({
  otlp: {
    endpoint: 'https://api.smith.langchain.com/otel/v1/traces',
    headers: {
      'x-api-key': process.env.LANGSMITH_API_KEY!,
      'Langsmith-Project': process.env.LANGSMITH_PROJECT ?? 'default',
    },
  },
  serviceName: 'my-worker',
});

// Apply to worker
const worker = await Worker.create({
  ...tracing.workerConfig,   // sinks + interceptors
  workflowsPath: require.resolve('./workflows'),
  activities,
  taskQueue: 'my-pipeline',
});

// Shutdown flushes pending spans
process.on('SIGTERM', () => tracing.shutdown());
```

**Layer 2: LLM tracing** via agent-runner inside containers. The agent-runner uses a `TracingAdapter` interface — default implementation uses LangSmith's `wrapClaudeAgentSDK`, but the adapter is swappable.

**Bridge: Activity → Container trace propagation:**

```typescript
import { getTraceEnvVars } from '@beruangai/agentforge-temporal-workflow';

/**
 * Extracts current trace context as env vars for container propagation.
 * Provider-agnostic: returns whatever env vars the configured adapter needs.
 * Default (LangSmith): RunTree headers as LANGSMITH_PARENT_* env vars.
 */
function getTraceEnvVars(): Record<string, string>;
```

**Resulting trace hierarchy:**
```
parent-workflow (Temporal workflow span via OTel)
├── child-workflow-1 (child workflow span)
│   └── task-a (activity span)
│       └── agent-task (LLM tracing chain)
│           ├── claude.assistant.turn (LLM span)
│           └── tool:search (tool span)
├── child-workflow-2 (child workflow span)
│   ├── task-b (activity span)
│   │   └── agent-task → turns + tools
│   └── task-c (activity span)
│       └── agent-task → turns + tools
...
```

### `createTracingConfig()` — Tracing Setup Helper

```typescript
interface OtlpConfig {
  /** OTLP endpoint URL (e.g., LangSmith, Langfuse, BrainTrust, Jaeger) */
  endpoint: string;
  /** Auth and routing headers */
  headers: Record<string, string>;
}

interface TracingConfig {
  /** Standard OTLP exporter config — provider-agnostic */
  otlp: OtlpConfig;
  /** Service name for span attribution */
  serviceName: string;
}

interface TracingResult {
  /** Spread into Worker.create() options */
  workerConfig: {
    sinks: WorkerOptions['sinks'];
    interceptors: WorkerOptions['interceptors'];
  };
  /** Call on shutdown to flush pending spans */
  shutdown(): Promise<void>;
}

function createTracingConfig(config: TracingConfig): TracingResult;
```

Internally configures:
- `OTLPTraceExporter` pointing to the provided endpoint (not hardcoded)
- `NodeTracerProvider` with `BatchSpanProcessor`
- `makeWorkflowExporter` sink for workflow spans
- `OpenTelemetryActivityInboundInterceptor` for activity spans

### Provider Swappability

LangSmith-specific code is isolated in two locations:
1. **`temporal-workflow/tracing/trace-env.ts`** — extracts `RunTree` headers as env vars (LangSmith-specific)
2. **`claude-sandbox/agent-runner/tracing.ts`** — `wrapClaudeAgentSDK` + `RunTree.fromHeaders()` (LangSmith-specific)

The OTel layer (Temporal interceptors, OTLP exporter) is fully provider-agnostic. Swapping to Langfuse or BrainTrust requires changing only these two files — no cross-package refactor. If multiple providers need to coexist, extract into a separate `agentforge-observability` package at that point.

## Error Handling

### Error Classification

Activities classify errors into Temporal `ApplicationFailure` types:

| Error | Retryable | Source |
|-------|-----------|--------|
| Container startup failure | Yes | Docker/SandboxRunner |
| Container timeout | Yes | heartbeatTimeout or startToCloseTimeout |
| Network error (transient) | Yes | Container or tool API |
| Agent task error (general) | Yes | Agent SDK inside container |
| Schema validation failure | **No** | Output doesn't match Zod schema |
| Permission denied | **No** | Credential or access failure |
| Invalid configuration | **No** | Bad activity input |

Non-retryable errors use `ApplicationFailure.nonRetryable()` which Temporal's retry policy respects via `nonRetryableErrorTypes`.

### Consumer Error Handling

Consumers use standard `try/catch` in workflows:

```typescript
try {
  const result = await activities.runTask(input);
} catch (err) {
  // After all retries exhausted, workflow gets ActivityFailure
  return { status: 'degraded', reason: err.message };
}
```

## Testing Approach

### Unit Tests

- `createClaudeSandboxActivity()` lifecycle: heartbeat starts/stops, trace env injected, output validated
- Retry classification: verify retryable vs non-retryable error mapping
- Output validation: valid output passes, invalid output throws non-retryable error
- Trace propagation: `getTraceEnvVars()` extracts correct headers
- `createTracingConfig()`: returns correct OTel provider, worker sinks/interceptors, shutdown flushes
- Preset composition: custom presets merge correctly with defaults

**Mock boundary**: `SandboxRunner.execute()` — mock at this boundary to test activity behavior without Docker.

### Integration Tests

- Full activity execution with real `SandboxRunner` (requires Docker)
- LangSmith trace hierarchy verification (workflow → activity → container → agent SDK)
- Temporal OTel interceptor span export to LangSmith OTLP endpoint
- Temporal `TestWorkflowEnvironment` with time-skipping for workflow-level tests

## File Structure

```
packages/temporal-workflow/src/
├── index.ts                    # Public API exports
├── activity/
│   ├── create-claude-sandbox-activity.ts  # Activity factory
│   ├── error-classification.ts   # Error → ApplicationFailure mapping
│   └── types.ts                  # CreateClaudeSandboxActivityConfig, SandboxExecutionConfig
├── retry/
│   ├── presets.ts                # Retry policy presets
│   └── types.ts                  # RetryPreset type
├── tracing/
│   ├── tracing-config.ts         # createTracingConfig (OTel + Temporal interceptors)
│   ├── trace-env.ts              # getTraceEnvVars (activity → container propagation)
│   └── types.ts                  # TracingConfig, TracingResult
└── __tests__/
    ├── create-claude-sandbox-activity.test.ts
    ├── error-classification.test.ts
    ├── retry-presets.test.ts
    └── tracing.test.ts
```
