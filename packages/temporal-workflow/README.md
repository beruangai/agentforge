# @beruangai/agentforge-temporal-workflow

Activity factories, retry presets, and tracing helpers for Temporal workflows wrapping sandboxed agent tasks.

## Usage

### Activity Factory

```typescript
import { createClaudeSandboxActivity } from '@beruangai/agentforge-temporal-workflow';
import { SandboxRunner } from '@beruangai/agentforge-claude-sandbox';
import { z } from 'zod';

const runner = new SandboxRunner();

const TaskOutput = z.object({ summary: z.string(), score: z.number() });

const runAnalysis = createClaudeSandboxActivity({
  name: 'analyze-data',
  runner,
  gateway, // optional — Gateway instance for MCP tool access
  sandbox: (input: { dataPath: string }) => ({
    prompt: `Analyze the data at /workspace/data and produce a summary.`,
    model: 'sonnet',
    allowedTools: ['Read', 'Grep', 'Bash'],
    volumes: { [input.dataPath]: '/workspace/data' },
    tools: ['search-api:*'], // gateway tool filters
  }),
  outputSchema: TaskOutput,
  heartbeatInterval: 15_000,
  timeout: 300_000,
});
```

### Retry Presets

```typescript
import { retryPresets } from '@beruangai/agentforge-temporal-workflow';
import { proxyActivities } from '@temporalio/workflow';

const research = proxyActivities<typeof activities>({
  ...retryPresets.longRunning, // 15min timeout, 3 retries
});

const analysis = proxyActivities<typeof activities>({
  ...retryPresets.standard, // 10min timeout, 2 retries
});

const snapshot = proxyActivities<typeof activities>({
  ...retryPresets.quick, // 5min timeout, 2 retries
});

// Custom preset
const custom = proxyActivities<typeof activities>({
  ...retryPresets.custom({ startToCloseTimeout: '20 minutes' }),
});
```

### Tracing

```typescript
import { createTracingConfig } from '@beruangai/agentforge-temporal-workflow';
import { Worker } from '@temporalio/worker';

const tracing = await createTracingConfig({
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
  ...tracing.workerConfig,
  workflowsPath: require.resolve('./workflows'),
  activities,
  taskQueue: 'my-pipeline',
});

process.on('SIGTERM', () => tracing.shutdown());
```

## Building

```bash
bunx nx build @beruangai/agentforge-temporal-workflow
```

## Testing

```bash
bunx nx test @beruangai/agentforge-temporal-workflow
```
