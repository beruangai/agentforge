import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';

// Mock @temporalio/activity
const mockHeartbeat = vi.fn();
vi.mock('@temporalio/activity', () => ({
  Context: {
    current: () => ({ heartbeat: mockHeartbeat }),
  },
}));

// Mock trace-env
vi.mock('../tracing/trace-env.js', () => ({
  getTraceEnvVars: vi.fn().mockResolvedValue({
    LANGSMITH_PARENT_DOTTED_ORDER: 'test-trace-id',
  }),
}));

const { createClaudeSandboxActivity } =
  await import('./create-claude-sandbox-activity.js');
const { getTraceEnvVars } = await import('../tracing/trace-env.js');

// Helpers
function mockRunner(
  output = { status: 'success' as const, structuredOutput: { result: 'ok' } },
) {
  return {
    execute: vi.fn().mockResolvedValue(output),
  };
}

describe('createClaudeSandboxActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes sandbox task and returns structured output', async () => {
    const runner = mockRunner();
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: (input: { query: string }) => ({
        prompt: input.query,
        model: 'sonnet',
      }),
    });

    const result = await activity({ query: 'hello' });

    expect(result).toEqual({ result: 'ok' });
    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          name: 'test-task',
          prompt: 'hello',
          model: 'sonnet',
        }),
      }),
    );
  });

  describe('heartbeat management', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends heartbeats at configured interval', async () => {
      const runner = mockRunner();
      runner.execute.mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  status: 'success',
                  structuredOutput: { result: 'ok' },
                }),
              50_000,
            ),
          ),
      );

      const activity = createClaudeSandboxActivity({
        name: 'test-task',
        runner: runner as any,
        heartbeatInterval: 10_000,
        sandbox: () => ({ prompt: 'hello' }),
      });

      const resultPromise = activity({});

      await vi.advanceTimersByTimeAsync(25_000);
      expect(mockHeartbeat).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(30_000);
      await resultPromise;
    });

    it('stops heartbeat on completion', async () => {
      const runner = mockRunner();
      const activity = createClaudeSandboxActivity({
        name: 'test-task',
        runner: runner as any,
        heartbeatInterval: 5_000,
        sandbox: () => ({ prompt: 'hello' }),
      });

      await vi.advanceTimersByTimeAsync(0);
      await activity({});

      mockHeartbeat.mockClear();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockHeartbeat).not.toHaveBeenCalled();
    });

    it('stops heartbeat on error', async () => {
      const runner = mockRunner({
        status: 'error',
        structuredOutput: undefined,
        error: 'failed',
      } as any);
      const activity = createClaudeSandboxActivity({
        name: 'test-task',
        runner: runner as any,
        heartbeatInterval: 5_000,
        sandbox: () => ({ prompt: 'hello' }),
      });

      // Attach catch handler immediately to prevent unhandled rejection
      const promise = activity({}).catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      await promise;

      mockHeartbeat.mockClear();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mockHeartbeat).not.toHaveBeenCalled();
    });
  });

  it('injects trace env vars into container', async () => {
    const runner = mockRunner();
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: (input: { query: string }) => ({
        prompt: input.query,
        env: { CUSTOM_VAR: 'custom' },
      }),
    });

    await activity({ query: 'hello' });

    expect(getTraceEnvVars).toHaveBeenCalled();
    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          CUSTOM_VAR: 'custom',
          LANGSMITH_PARENT_DOTTED_ORDER: 'test-trace-id',
        },
      }),
    );
  });

  it('validates output against Zod schema', async () => {
    const schema = z.object({ result: z.string() });
    const runner = mockRunner({
      status: 'success',
      structuredOutput: { result: 'ok' },
    });
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      outputSchema: schema,
      sandbox: () => ({ prompt: 'hello' }),
    });

    const result = await activity({});
    expect(result).toEqual({ result: 'ok' });
  });

  it('throws non-retryable error on schema validation failure', async () => {
    const schema = z.object({ result: z.number() });
    const runner = mockRunner({
      status: 'success',
      structuredOutput: { result: 'not-a-number' },
    });
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      outputSchema: schema,
      sandbox: () => ({ prompt: 'hello' }),
    });

    try {
      await activity({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      const af = err as ApplicationFailure;
      expect(af.type).toBe('SchemaValidationError');
      expect(af.nonRetryable).toBe(true);
    }
  });

  it('skips validation when no schema provided', async () => {
    const runner = mockRunner({
      status: 'success',
      structuredOutput: { anything: true },
    } as any);
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: () => ({ prompt: 'hello' }),
    });

    const result = await activity({});
    expect(result).toEqual({ anything: true });
  });

  it('passes outputFormat from Zod schema as draft-07', async () => {
    const schema = z.object({ result: z.string() });
    const runner = mockRunner({
      status: 'success',
      structuredOutput: { result: 'ok' },
    });
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      outputSchema: schema,
      sandbox: () => ({ prompt: 'hello' }),
    });

    await activity({});

    const executeCall = runner.execute.mock.calls[0][0];
    expect(executeCall.input.outputFormat).toEqual(
      expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({
          result: expect.objectContaining({ type: 'string' }),
        }),
      }),
    );
  });

  it('throws retryable error when sandbox returns error status', async () => {
    const runner = mockRunner({
      status: 'error',
      structuredOutput: undefined,
      error: 'container crashed',
    } as any);
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: () => ({ prompt: 'hello' }),
    });

    try {
      await activity({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      const af = err as ApplicationFailure;
      expect(af.type).toBe('AgentTaskError');
      expect(af.nonRetryable).toBe(false);
      expect(af.message).toContain('container crashed');
    }
  });

  it('passes timeout and network to runner', async () => {
    const runner = mockRunner();
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      timeout: 600_000,
      sandbox: () => ({
        prompt: 'hello',
        network: 'agentforge-net',
      }),
    });

    await activity({});

    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 600_000,
        network: 'agentforge-net',
      }),
    );
  });

  it('classifies unknown errors via classifyError', async () => {
    const runner = mockRunner();
    runner.execute.mockRejectedValueOnce(
      new Error('Docker daemon not running'),
    );
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: () => ({ prompt: 'hello' }),
    });

    try {
      await activity({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      const af = err as ApplicationFailure;
      expect(af.type).toBe('AgentTaskError');
      expect(af.nonRetryable).toBe(false);
    }
  });

  it('classifies permission errors as non-retryable', async () => {
    const runner = mockRunner();
    runner.execute.mockRejectedValueOnce(
      new Error('Permission denied: cannot access Docker socket'),
    );
    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: () => ({ prompt: 'hello' }),
    });

    try {
      await activity({});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      const af = err as ApplicationFailure;
      expect(af.type).toBe('PermissionDenied');
      expect(af.nonRetryable).toBe(true);
    }
  });
});
