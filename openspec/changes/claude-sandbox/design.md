# Design: Claude Sandbox Package

## Public API

### `SandboxRunner`

Main class for executing agent tasks in Docker containers.

```typescript
import { SandboxRunner } from '@beruangai/agentforge-claude-sandbox';

const runner = new SandboxRunner({
  defaultTimeout: 300_000,    // 5 minutes
  cleanupOnExit: true,        // remove containers after execution
  sessionsDir: './data/sessions', // host dir for .claude session mounts
  // image defaults to 'agentforge-claude:latest', auto-built from bundled Dockerfile
  // dockerfile: './custom/Dockerfile' — override if needed
});

const result = await runner.execute({
  input: {
    name: 'comprehensive-research',
    prompt: 'Research the market trends for...',
    model: 'sonnet',
    maxTurns: 60,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch'],
    disallowedTools: ['Write'],
    outputFormat: { /* JSON Schema draft-07 */ },
    mcpServers: {
      gateway: { type: 'http', url: 'http://host.docker.internal:8080/mcp/research' },
    },
  },
  volumes: {
    '/host/data/entity': '/workspace/entity',
    '/host/context': { target: '/workspace/context', readonly: true },
  },
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
    CUSTOM_VAR: 'value',
  },
  timeout: 600_000,
  network: 'agentforge-net',
});

// result: AgentForgeContainerOutput
// result.status: 'success' | 'error'
// result.structuredOutput: unknown (matches outputFormat schema)
// result.sessionId: string | undefined
// result.metrics: { tokens, toolCalls, durationMs } | undefined
// result.error: string | undefined
```

### Type Signatures

```typescript
interface SandboxRunnerConfig {
  /** Docker image tag (default: 'agentforge-claude:latest') */
  image?: string;
  /** Custom Dockerfile path (overrides bundled default) */
  dockerfile?: string;
  /** Default execution timeout in ms (default: 300000) */
  defaultTimeout?: number;
  /** Remove containers after execution (default: true) */
  cleanupOnExit?: boolean;
  /** Host directory for session persistence (default: ./data/sessions) */
  sessionsDir?: string;
  /** Credential injection mode */
  credentials?: CredentialConfig;
}

interface CredentialConfig {
  /** 'env' = pass API key as env var; 'onecli' = use OneCLI HTTPS proxy */
  mode: 'env' | 'onecli';
  /** OneCLI proxy URL (required for 'onecli' mode) */
  proxyUrl?: string;
  /** Agent identifier for multi-credential OneCLI (optional) */
  agent?: string;
}

interface ExecuteConfig {
  /** Agent task input (sent to agent-runner via stdin) */
  input: AgentForgeContainerInput;
  /** Volume mounts: host path → container path or { target, readonly } */
  volumes?: VolumeMap;
  /** Environment variables for the container */
  env?: Record<string, string>;
  /** Execution timeout in ms (overrides runner default) */
  timeout?: number;
  /** Docker network to attach container to */
  network?: string;
  /** Extra /etc/hosts entries (default: ['host.docker.internal:host-gateway']) */
  extraHosts?: string[];
}

interface AgentForgeContainerInput {
  /** Task name (used in tracing and container naming) */
  name: string;
  /** Prompt for the agent (string or message blocks) */
  prompt: string | MessageBlock[];
  /** Model to use (e.g., 'sonnet', 'haiku', 'opus') */
  model?: string;
  /** Maximum agent turns */
  maxTurns?: number;
  /** Allowed tools whitelist */
  allowedTools?: string[];
  /** Disallowed tools blacklist */
  disallowedTools?: string[];
  /** JSON Schema for structured output (draft-07) */
  outputFormat?: object;
  /** MCP server configurations */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Session ID for resumption */
  sessionId?: string;
  /** Additional env vars to pass to Agent SDK */
  env?: Record<string, string>;
}

interface AgentForgeContainerOutput {
  status: 'success' | 'error';
  structuredOutput?: unknown;
  sessionId?: string;
  metrics?: {
    tokens: number;
    toolCalls: number;
    durationMs: number;
  };
  error?: string;
}

type VolumeMap = Record<string, string | { target: string; readonly?: boolean }>;

interface MessageBlock {
  type: 'text' | 'document' | 'image';
  text?: string;
  title?: string;
  content?: string;
  filePath?: string;
  source?: string;
  mediaType?: string;
}
```

## Internal Architecture

### Container Lifecycle (`container-runner.ts`)

```
execute(config)
  │
  ├── 1. Resolve volumes (static paths + dynamic functions)
  ├── 2. Compute container identity (config hash → name)
  ├── 3. Mount session directory (.claude/ keyed by config hash)
  ├── 4. Create container (image, volumes, env, network, extraHosts)
  ├── 5. Attach stdin/stdout/stderr streams
  ├── 6. Start container
  ├── 7. Write AgentForgeContainerInput to stdin (JSON)
  ├── 8. Collect stdout, monitor for sentinel markers
  ├── 9. Wait for container exit (with timeout)
  ├── 10. Extract output between sentinels
  ├── 11. Parse JSON → AgentForgeContainerOutput
  ├── 12. Cleanup container (if cleanupOnExit)
  └── 13. Return result
```

### Container Identity (`identity.ts`)

```typescript
import { createHash } from 'crypto';

export function containerName(
  taskName: string,
  image: string,           // from SandboxRunnerConfig
  config: ExecuteConfig,
): string {
  const hash = createHash('sha256')
    .update(JSON.stringify({
      image,
      volumes: sortedEntries(resolveVolumes(config.volumes)),
    }))
    .digest('hex')
    .slice(0, 12);
  return `agentforge-${taskName}-${hash}`;
}
```

Same config hash → same container name → same session `.claude/` mount. Enables session resumption across retries.

### Sentinel I/O Protocol (`sentinel.ts`)

```typescript
const START_SENTINEL = '---AGENTFORGE_OUTPUT_START---';
const END_SENTINEL = '---AGENTFORGE_OUTPUT_END---';

export function extractOutput(stdout: string): AgentForgeContainerOutput | null {
  const startIdx = stdout.indexOf(START_SENTINEL);
  const endIdx = stdout.indexOf(END_SENTINEL);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null;
  }

  const jsonStr = stdout.slice(startIdx + START_SENTINEL.length, endIdx).trim();
  return JSON.parse(jsonStr);
}
```

### Session Management (`sessions.ts`)

```typescript
export function sessionMountPath(sessionsDir: string, containerName: string): string {
  const sessionDir = path.join(sessionsDir, containerName, '.claude');
  fs.mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}

// Volume mount: sessionMountPath → /home/agent/.claude
```

### Host Networking (`container-runner.ts`)

Containers need to reach host-side services (e.g., MCP gateway). The runner auto-injects `--add-host=host.docker.internal:host-gateway` by default so `host.docker.internal` resolves on all platforms (Docker Desktop already supports it natively; Linux requires the extra-hosts flag).

```typescript
// Default extraHosts — always injected unless overridden
const DEFAULT_EXTRA_HOSTS = ['host.docker.internal:host-gateway'];
```

Consumers reference host services via `http://host.docker.internal:<port>` in their MCP server configs. Combined with the `network` option (e.g., `'agentforge-net'`), containers can reach both host services and other containers on the same network.

### Docker Binary Abstraction (`container-runtime.ts`)

Wraps `dockerode` for container operations. Provides:
- `createContainer(config)` — create with volumes, env, network, extraHosts
- `startContainer(id)` — start and attach streams
- `waitContainer(id, timeout)` — wait for exit with timeout
- `removeContainer(id)` — cleanup
- `inspectContainer(id)` — check status

## Agent Runner (Container-Side)

### Entry Point (`agent-runner/index.ts`)

Runs inside the container as the Dockerfile entrypoint:

```typescript
#!/usr/bin/env bun
import * as claudeSDK from '@anthropic-ai/claude-code';
import { wrapClaudeAgentSDK } from 'langsmith/experimental/anthropic';
import { RunTree } from 'langsmith';
import { withRunTree } from 'langsmith/traceable';

// Read input from stdin
const input: AgentForgeContainerInput = JSON.parse(await Bun.stdin.text());

// Wrap SDK with LangSmith tracing
const { query } = wrapClaudeAgentSDK(claudeSDK);

// Reconstruct parent trace context (if available)
const parentHeaders = {
  'langsmith-trace': process.env.LANGSMITH_PARENT_DOTTED_ORDER,
  'baggage': process.env.LANGSMITH_PARENT_BAGGAGE,
};

const parentRunTree = parentHeaders['langsmith-trace']
  ? RunTree.fromHeaders(parentHeaders, { name: 'parent', run_type: 'chain' })
  : null;

// Build query options
const queryOptions = {
  prompt: input.prompt,
  options: {
    cwd: '/workspace',
    settingSources: ['project', 'user'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    allowedTools: input.allowedTools,
    disallowedTools: input.disallowedTools,
    maxTurns: input.maxTurns,
    model: input.model,
    outputFormat: input.outputFormat,
    env: input.env,
    mcpServers: input.mcpServers,
    ...(input.sessionId ? { resume: input.sessionId } : {}),
    ...(!input.sessionId ? { sessionId: crypto.randomUUID() } : {}),
  },
};

// Execute
async function executeQuery() {
  let structuredOutput: unknown;
  let sessionId: string | undefined;
  let tokens = 0;
  let toolCalls = 0;
  const startTime = Date.now();

  for await (const message of query(queryOptions)) {
    if (message.type === 'result') {
      structuredOutput = message.structured_output;
      sessionId = message.session_id;
    }
    // Track metrics from assistant messages
    if (message.type === 'assistant' && message.usage) {
      tokens += (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0);
    }
    if (message.type === 'tool_use') {
      toolCalls++;
    }
  }

  return {
    structuredOutput,
    sessionId,
    metrics: { tokens, toolCalls, durationMs: Date.now() - startTime },
  };
}

try {
  let result;

  if (parentRunTree) {
    const childRun = parentRunTree.createChild({
      name: input.name ?? 'agent-task',
      run_type: 'chain',
      inputs: { prompt: input.prompt, model: input.model },
    });

    result = await withRunTree(childRun, executeQuery);
    childRun.end({ outputs: result });
    await childRun.patchRun();
  } else {
    result = await executeQuery();
  }

  // Emit sentinel-wrapped output
  const output: AgentForgeContainerOutput = {
    status: 'success',
    structuredOutput: result.structuredOutput,
    sessionId: result.sessionId,
    metrics: result.metrics,
  };

  process.stdout.write('---AGENTFORGE_OUTPUT_START---\n');
  process.stdout.write(JSON.stringify(output));
  process.stdout.write('\n---AGENTFORGE_OUTPUT_END---\n');
  process.exit(0);
} catch (error) {
  const output: AgentForgeContainerOutput = {
    status: 'error',
    error: error instanceof Error ? error.message : String(error),
  };

  process.stdout.write('---AGENTFORGE_OUTPUT_START---\n');
  process.stdout.write(JSON.stringify(output));
  process.stdout.write('\n---AGENTFORGE_OUTPUT_END---\n');
  process.exit(1);
}
```

### Image Management (`image-manager.ts`)

`SandboxRunner` automatically builds the base Docker image on first use (or when the Dockerfile changes). Consumers don't manage image builds — the runner handles it transparently.

```typescript
class ImageManager {
  /**
   * Ensures the base image exists and is up to date.
   * Builds from the package's bundled Dockerfile if:
   * - The image doesn't exist locally
   * - The Dockerfile has changed (content hash mismatch)
   * Consumers can override with a custom Dockerfile path.
   */
  async ensureImage(config: {
    /** Image tag (default: 'agentforge-claude:latest') */
    image: string;
    /** Custom Dockerfile path (overrides bundled default) */
    dockerfile?: string;
  }): Promise<void>;
}
```

The bundled `Dockerfile.base` is shipped with the npm package. On `runner.execute()`, the runner checks if the image exists (and matches the expected content hash), building it automatically if needed. This is a one-time cost per Dockerfile change (~30s).

### Base Dockerfile

```dockerfile
FROM oven/bun:latest AS base

# Install Agent SDK
RUN bun install -g @anthropic-ai/claude-code

# Install LangSmith for tracing
RUN bun install -g langsmith

# Non-root user
RUN useradd -m -s /bin/bash agent
USER agent

# Clean .claude scope
RUN mkdir -p /home/agent/.claude \
    && echo '{}' > /home/agent/.claude/settings.json

WORKDIR /workspace

# Copy agent-runner
COPY agent-runner/ /app/agent-runner/

ENTRYPOINT ["bun", "run", "/app/agent-runner/index.ts"]
```

## Error Handling

### Container Errors

| Error | Handling |
|-------|----------|
| Image not found | Auto-build from bundled Dockerfile; throw if build fails |
| Container startup failure | Throw retryable error |
| Timeout (container running too long) | Kill container, throw retryable error |
| Non-zero exit code without sentinel | Throw with stderr content |
| Non-zero exit code with sentinel | Parse sentinel output, return error status |
| Sentinel not found in stdout | Throw with raw stdout (agent may have crashed) |
| Host unreachable from container | Network config error — verify `network` and `extraHosts` |
| JSON parse failure | Throw non-retryable (agent-runner bug) |

### Agent Runner Errors

The agent-runner always emits sentinel output, even on error. If the Agent SDK throws, it's caught, wrapped in error output, and emitted via sentinels. The only case where sentinels are missing is if the agent-runner itself crashes (OOM, segfault) — handled by the host-side "sentinel not found" case.

## Testing Approach

### Unit Tests

- **Sentinel extraction**: Valid sentinels, missing sentinels, malformed JSON, extra stdout noise
- **Container identity**: Same config → same hash, different config → different hash
- **Volume resolution**: Static paths, readonly mounts, missing paths
- **Session management**: Directory creation, path computation
- **Credential modes**: Env var injection, OneCLI config generation

**Mock boundary**: `dockerode` — mock Docker API to test container-runner logic without Docker.

### Integration Tests (Require Docker)

- **Full execution lifecycle**: Create → start → stdin → stdout → cleanup
- **Volume mounting**: Verify files are accessible inside container
- **Sentinel I/O**: Real agent-runner producing sentinel output
- **Session persistence**: Execute, verify session dir created, re-execute with same config
- **Timeout handling**: Container killed after timeout
- **Error propagation**: Agent error → sentinel error output → host error

### Agent Runner Tests

- **Input parsing**: Valid and invalid JSON on stdin
- **Metric collection**: Token counting, tool call counting, duration
- **Trace propagation**: Parent env vars → RunTree reconstruction
- **Structured output**: outputFormat schema honored by Agent SDK
- **Graceful shutdown**: Clean exit on completion, error sentinel on failure

## File Structure

```
packages/claude-sandbox/src/
├── index.ts                      # Public API exports
├── runner/
│   ├── sandbox-runner.ts         # SandboxRunner class
│   ├── container-runner.ts       # Container lifecycle (create, start, wait, cleanup)
│   ├── container-runtime.ts      # dockerode abstraction
│   ├── sentinel.ts               # Sentinel I/O extraction
│   └── types.ts                  # ExecuteConfig, AgentForgeContainerInput/Output
├── identity/
│   ├── container-identity.ts     # Config-hash container naming
│   └── sessions.ts               # Session directory management
├── volumes/
│   └── volume-resolver.ts        # VolumeMap resolution and validation
├── image/
│   └── image-manager.ts          # Auto-build base image, content-hash check
├── credentials/
│   └── credential-config.ts      # Env var and OneCLI credential modes
├── __tests__/
│   ├── sandbox-runner.test.ts
│   ├── sentinel.test.ts
│   ├── container-identity.test.ts
│   ├── volume-resolver.test.ts
│   └── integration/
│       ├── full-lifecycle.test.ts
│       └── session-persistence.test.ts
├── agent-runner/                  # Bundled into Docker image (not published as npm)
│   ├── index.ts                   # Entry point
│   ├── output.ts                  # Sentinel output helpers
│   └── tracing.ts                 # LangSmith context reconstruction
└── docker/
    └── Dockerfile.base            # Base image definition
```
