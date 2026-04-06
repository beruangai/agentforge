# @beruangai/agentforge-claude-sandbox

Docker container lifecycle management for executing Claude Agent SDK tasks in isolated environments.

## Features

- **Container lifecycle**: Create, start, monitor, and clean up Docker containers
- **Sentinel I/O protocol**: Reliably extract typed JSON output from agent processes
- **Session management**: Persist and resume agent sessions via `.claude/` directory mounts
- **Credential injection**: API key via env vars (with OneCLI proxy mode stub)
- **Volume management**: Per-task filesystem mounts with readonly support
- **Auto image management**: Build base Docker image on first use

## Usage

```typescript
import { SandboxRunner } from '@beruangai/agentforge-claude-sandbox';

const runner = new SandboxRunner({
  defaultTimeout: 300_000,
  cleanupOnExit: true,
  sessionsDir: './data/sessions',
});

const result = await runner.execute({
  input: {
    name: 'research-task',
    prompt: 'Research the market trends for...',
    model: 'sonnet',
    maxTurns: 60,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
  },
  volumes: {
    '/host/data/entity': '/workspace/entity',
    '/host/context': { target: '/workspace/context', readonly: true },
  },
  env: {
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
  },
  timeout: 600_000,
  network: 'agentforge-net',
});

// result.status: 'success' | 'error'
// result.structuredOutput: unknown
// result.sessionId: string | undefined
// result.metrics: { tokens, toolCalls, durationMs } | undefined
```

## Requirements

- Docker must be running on the host
- Node.js >= 20

## Architecture

The package has two components:

### Host-Side: SandboxRunner
Manages Docker container lifecycle -- creates containers, writes input via stdin, reads output via sentinel protocol, handles cleanup.

### Container-Side: Agent Runner
Runs inside the Docker container. Reads `AgentForgeContainerInput` from stdin, executes the Claude Agent SDK, emits structured output via sentinel markers.

### Sentinel I/O Protocol
```
---AGENTFORGE_OUTPUT_START---
{"status":"success","structuredOutput":{...}}
---AGENTFORGE_OUTPUT_END---
```

## Testing

```bash
# Unit tests
bunx nx test @beruangai/agentforge-claude-sandbox

# Integration tests (requires Docker)
INTEGRATION=true bunx vitest run --config packages/claude-sandbox/vitest.config.mts
```
