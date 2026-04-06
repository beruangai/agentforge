# Design: Temporal Workflow Package

## Public API

### `createClaudeSandboxActivity()`

Activity factory that wraps `SandboxRunner.execute()` with heartbeat, tracing, gateway integration, and validation.

```typescript
import { createClaudeSandboxActivity } from '@beruangai/agentforge-temporal-workflow';
import { SandboxRunner } from '@beruangai/agentforge-claude-sandbox';
import type { Gateway } from '@beruangai/agentforge-mcp-gateway';
import { z } from 'zod';

const runner = new SandboxRunner();

// Returns a Temporal activity function
const runTask = createClaudeSandboxActivity({
  name: 'my-agent-task',
  runner,
  gateway, // Gateway instance — used to generate mcpServers config per activity

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
    // Tool filter patterns — gateway.mcpServersConfig() generates the mcpServers config
    tools: ['search-api:*', 'data-api:*'],
  }),

  // Output validation (Zod v4+, draft-07)
  outputSchema: TaskOutputSchema,

  // Heartbeat (default 15s)
  heartbeatInterval: 15_000,

  // Timeout (overrides SandboxRunner default)
  timeout: 300_000,
});
```

### Type Signature

Uses types directly from claude-sandbox — no duplication.

```typescript
import type { ExecuteConfig, AgentForgeContainerInput } from '@beruangai/agentforge-claude-sandbox';
import type { Gateway } from '@beruangai/agentforge-mcp-gateway';

interface CreateClaudeSandboxActivityConfig<TInput, TOutput> {
  /** Activity name (used in tracing and logging) */
  name: string;

  /** SandboxRunner instance */
  runner: SandboxRunner;

  /** Gateway instance for MCP tool access */
  gateway?: Gateway;

  /** Build sandbox execution config from activity input */
  sandbox: (input: TInput) => SandboxActivityConfig;

  /** Zod schema for output validation (optional — skips validation if omitted) */
  outputSchema?: z.ZodType<TOutput>;

  /** Heartbeat interval in ms (default: 15000) */
  heartbeatInterval?: number;

  /** Execution timeout in ms (default: runner's default) */
  timeout?: number;
}

/**
 * Sandbox activity config — extends claude-sandbox's input types
 * with activity-specific concerns (tool filtering).
 * Maps to ExecuteConfig + AgentForgeContainerInput at execution time.
 */
interface SandboxActivityConfig {
  // Maps to AgentForgeContainerInput
  prompt: string | MessageBlock[];
  model?: string;
  maxTurns?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
  outputFormat?: object;
  mcpServers?: Record<string, MCPServerConfig>;
  sessionId?: string;

  // Maps to ExecuteConfig
  volumes?: VolumeMap;
  env?: Record<string, string>;
  network?: string;

  // Activity-specific: tool filter patterns for gateway
  // Used with gateway.mcpServersConfig(tools) to auto-generate mcpServers
  tools?: string[];
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
  const { name, runner, gateway, sandbox, outputSchema, heartbeatInterval = 15_000, timeout } = config;

  return wrapActivityWithTracing(name, async (input: TInput): Promise<TOutput> => {
    // Start heartbeat
    const heartbeatTimer = setInterval(() => heartbeat(), heartbeatInterval);

    try {
      // Get trace env vars for container propagation
      const traceEnv = getTraceEnvVars();

      // Build sandbox config
      const activityConfig = sandbox(input);

      // Generate mcpServers from gateway + tool filters
      let mcpServers = activityConfig.mcpServers;
      if (gateway && activityConfig.tools) {
        mcpServers = {
          ...mcpServers,
          ...gateway.mcpServersConfig(activityConfig.tools),
        };
      }

      // Execute in container — maps SandboxActivityConfig to ExecuteConfig
      const result = await runner.execute({
        input: {
          name,
          prompt: activityConfig.prompt,
          model: activityConfig.model,
          maxTurns: activityConfig.maxTurns,
          allowedTools: activityConfig.allowedTools,
          disallowedTools: activityConfig.disallowedTools,
          outputFormat: outputSchema
            ? z.toJSONSchema(outputSchema, { target: 'draft-07' })
            : activityConfig.outputFormat,
          mcpServers,
          sessionId: activityConfig.sessionId,
        },
        volumes: activityConfig.volumes,
        env: { ...activityConfig.env, ...traceEnv },
        timeout,
        network: activityConfig.network,
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
    ...retryPresets.standard,
    ...overrides,
  }),
} as const;
```

**Usage in consumer workflow:**

```typescript
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

Two tracing layers unified in a single trace tree:

1. **Temporal workflow/activity spans** — Provider-agnostic via OpenTelemetry interceptors + OTLP exporter
2. **LLM tracing** — LangSmith adapter (isolated in `tracing/langsmith-adapter.ts`), invoked by core but not coupled throughout

**Architecture:**
- `tracing/tracing-config.ts` — OTel provider setup, OTLP exporter (provider-agnostic)
- `tracing/trace-env.ts` — core trace env extraction interface
- `tracing/langsmith-adapter.ts` — LangSmith-specific: `RunTree` header extraction, `wrapClaudeAgentSDK`. **Only LangSmith import in the package.**

The core activity factory imports from `tracing/trace-env.ts` (not directly from langsmith). Swapping to Langfuse or BrainTrust means replacing `langsmith-adapter.ts` — no changes to core.

**Layer 1: OTel config (provider-agnostic):**

```typescript
import { createTracingConfig } from '@beruangai/agentforge-temporal-workflow';

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

const worker = await Worker.create({
  ...tracing.workerConfig,   // sinks + interceptors
  workflowsPath: require.resolve('./workflows'),
  activities,
  taskQueue: 'my-pipeline',
});

process.on('SIGTERM', () => tracing.shutdown());
```

**Layer 2: LLM trace bridge (LangSmith adapter):**

```typescript
import { getTraceEnvVars } from '@beruangai/agentforge-temporal-workflow';

/**
 * Extracts current trace context as env vars for container propagation.
 * Delegates to the configured adapter (default: LangSmith RunTree headers).
 * Returns empty object if no trace context is active.
 */
function getTraceEnvVars(): Record<string, string>;
```

**Resulting trace hierarchy:**
```
parent-workflow (Temporal workflow span via OTel)
├── child-workflow-1 (child workflow span)
│   └── task-a (activity span)
│       └── agent-task (LLM tracing chain via adapter)
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
- Gateway integration: `mcpServersConfig(tools)` called with correct filters, merged into mcpServers
- Retry classification: verify retryable vs non-retryable error mapping
- Output validation: valid output passes, invalid output throws non-retryable error
- Trace propagation: `getTraceEnvVars()` extracts correct headers (mock LangSmith adapter)
- `createTracingConfig()`: returns correct OTel provider, worker sinks/interceptors, shutdown flushes
- Preset composition: custom presets merge correctly with defaults

**Mock boundary**: `SandboxRunner.execute()` and `Gateway` — mock at these boundaries to test activity behavior without Docker or real gateway.

### Integration Tests

- Docker integration: Temporal activity → `SandboxRunner.execute()` → real container lifecycle (requires Docker, `INTEGRATION=true`)
- End-to-end: Temporal `TestWorkflowEnvironment` with mocked activities for workflow-level tests (in-memory, no Docker)

## File Structure

```
packages/temporal-workflow/src/
├── index.ts                    # Public API exports
├── activity/
│   ├── create-claude-sandbox-activity.ts  # Activity factory
│   ├── error-classification.ts   # Error → ApplicationFailure mapping
│   └── types.ts                  # CreateClaudeSandboxActivityConfig, SandboxActivityConfig
├── retry/
│   ├── presets.ts                # Retry policy presets
│   └── types.ts                  # RetryPreset type
├── tracing/
│   ├── tracing-config.ts         # createTracingConfig (OTel + Temporal interceptors)
│   ├── trace-env.ts              # getTraceEnvVars (core interface, delegates to adapter)
│   ├── langsmith-adapter.ts      # LangSmith-specific: RunTree headers, wrapClaudeAgentSDK
│   └── types.ts                  # TracingConfig, TracingResult
└── __tests__/
    ├── create-claude-sandbox-activity.test.ts
    ├── error-classification.test.ts
    ├── retry-presets.test.ts
    ├── tracing.test.ts
    └── integration/
        └── sandbox-activity.test.ts  # Docker integration (INTEGRATION=true)
```
