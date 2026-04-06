import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock @temporalio/activity
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({ heartbeat: vi.fn() }),
  },
}));

// Mock trace-env
vi.mock('../tracing/trace-env.js', () => ({
  getTraceEnvVars: vi.fn().mockResolvedValue({}),
}));

const { createClaudeSandboxActivity } =
  await import('./create-claude-sandbox-activity.js');

function mockRunner() {
  return {
    execute: vi.fn().mockResolvedValue({
      status: 'success',
      structuredOutput: { result: 'ok' },
    }),
  };
}

describe('gateway integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls gateway.mcpServersConfig with tool patterns', async () => {
    const runner = mockRunner();
    const gateway = {
      close: vi.fn(),
      status: vi.fn(),
      mcpServersConfig: vi.fn().mockReturnValue({
        gateway: { type: 'http', url: 'http://localhost:8080/mcp' },
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      gateway: gateway as any,
      sandbox: () => ({
        prompt: 'hello',
        tools: ['search-api:*', 'data-api:query'],
      }),
    });

    await activity({});

    expect(gateway.mcpServersConfig).toHaveBeenCalledWith([
      'search-api:*',
      'data-api:query',
    ]);
  });

  it('merges gateway mcpServers with explicit mcpServers', async () => {
    const runner = mockRunner();
    const gateway = {
      close: vi.fn(),
      status: vi.fn(),
      mcpServersConfig: vi.fn().mockReturnValue({
        gateway: { type: 'http', url: 'http://localhost:8080/mcp' },
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      gateway: gateway as any,
      sandbox: () => ({
        prompt: 'hello',
        tools: ['search-api:*'],
        mcpServers: {
          custom: { type: 'stdio' as const, command: 'my-server' },
        },
      }),
    });

    await activity({});

    const executeCall = runner.execute.mock.calls[0][0];
    expect(executeCall.input.mcpServers).toEqual({
      custom: { type: 'stdio', command: 'my-server' },
      gateway: { type: 'http', url: 'http://localhost:8080/mcp' },
    });
  });

  it('skips gateway when no gateway instance provided', async () => {
    const runner = mockRunner();
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: () => ({
        prompt: 'hello',
        mcpServers: {
          custom: { type: 'stdio' as const, command: 'my-server' },
        },
      }),
    });

    await activity({});

    const executeCall = runner.execute.mock.calls[0][0];
    expect(executeCall.input.mcpServers).toEqual({
      custom: { type: 'stdio', command: 'my-server' },
    });
  });

  it('skips gateway when no tools specified', async () => {
    const runner = mockRunner();
    const gateway = {
      close: vi.fn(),
      status: vi.fn(),
      mcpServersConfig: vi.fn(),
    };

    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      gateway: gateway as any,
      sandbox: () => ({
        prompt: 'hello',
      }),
    });

    await activity({});

    expect(gateway.mcpServersConfig).not.toHaveBeenCalled();
  });
});
