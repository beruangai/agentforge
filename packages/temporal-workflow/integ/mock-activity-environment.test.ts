import { describe, expect, it, vi } from 'vitest';
import { MockActivityEnvironment } from '@temporalio/testing';
import { ApplicationFailure } from '@temporalio/common';
import { z } from 'zod';
import { createClaudeSandboxActivity } from '../src/activity/create-claude-sandbox-activity.js';

/**
 * MockActivityEnvironment test — validates that createClaudeSandboxActivity
 * produces activity functions that work correctly within Temporal's real
 * activity context (heartbeat, cancellation, etc.).
 *
 * Lightweight: no server, no Docker, no network.
 */

// Mock trace-env to avoid langsmith dependency in test
vi.mock('../src/tracing/trace-env.js', () => ({
  getTraceEnvVars: vi.fn().mockResolvedValue({}),
}));

describe('MockActivityEnvironment — activity factory in Temporal context', () => {
  it('activity runs in Temporal context and returns output', async () => {
    const runner = {
      execute: vi.fn().mockResolvedValue({
        status: 'success',
        structuredOutput: { summary: 'done', score: 10 },
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'test-task',
      runner: runner as any,
      sandbox: (input: { query: string }) => ({
        prompt: input.query,
        model: 'sonnet',
      }),
    });

    const env = new MockActivityEnvironment();
    const result = await env.run(activity, { query: 'analyze this' });

    expect(result).toEqual({ summary: 'done', score: 10 });
    expect(runner.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          name: 'test-task',
          prompt: 'analyze this',
          model: 'sonnet',
        }),
      }),
    );
  });

  it('heartbeats are emitted to Temporal context', async () => {
    const runner = {
      execute: vi.fn().mockImplementation(
        () =>
          new Promise((resolve) =>
            setTimeout(() => resolve({ status: 'success', structuredOutput: {} }), 100),
          ),
      ),
    };

    const activity = createClaudeSandboxActivity({
      name: 'heartbeat-test',
      runner: runner as any,
      heartbeatInterval: 20,
      sandbox: () => ({ prompt: 'test' }),
    });

    const env = new MockActivityEnvironment();
    const heartbeats: unknown[] = [];
    env.on('heartbeat', (details) => heartbeats.push(details));

    await env.run(activity, {});

    // At least one heartbeat should have been emitted during the 100ms execution
    expect(heartbeats.length).toBeGreaterThanOrEqual(1);
  });

  it('output validation works in Temporal context', async () => {
    const schema = z.object({ summary: z.string(), score: z.number() });
    const runner = {
      execute: vi.fn().mockResolvedValue({
        status: 'success',
        structuredOutput: { summary: 'ok', score: 5 },
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'validated-task',
      runner: runner as any,
      outputSchema: schema,
      sandbox: () => ({ prompt: 'test' }),
    });

    const env = new MockActivityEnvironment();
    const result = await env.run(activity, {});
    expect(result).toEqual({ summary: 'ok', score: 5 });
  });

  it('schema validation failure throws non-retryable ApplicationFailure', async () => {
    const schema = z.object({ score: z.number() });
    const runner = {
      execute: vi.fn().mockResolvedValue({
        status: 'success',
        structuredOutput: { score: 'not-a-number' },
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'bad-output-task',
      runner: runner as any,
      outputSchema: schema,
      sandbox: () => ({ prompt: 'test' }),
    });

    const env = new MockActivityEnvironment();
    try {
      await env.run(activity, {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      const af = err as ApplicationFailure;
      expect(af.type).toBe('SchemaValidationError');
      expect(af.nonRetryable).toBe(true);
    }
  });

  it('error status throws retryable ApplicationFailure', async () => {
    const runner = {
      execute: vi.fn().mockResolvedValue({
        status: 'error',
        error: 'container crashed',
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'failing-task',
      runner: runner as any,
      sandbox: () => ({ prompt: 'test' }),
    });

    const env = new MockActivityEnvironment();
    try {
      await env.run(activity, {});
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApplicationFailure);
      const af = err as ApplicationFailure;
      expect(af.type).toBe('AgentTaskError');
      expect(af.nonRetryable).toBe(false);
    }
  });

  it('gateway integration works in Temporal context', async () => {
    const runner = {
      execute: vi.fn().mockResolvedValue({
        status: 'success',
        structuredOutput: { result: 'ok' },
      }),
    };
    const gateway = {
      close: vi.fn(),
      status: vi.fn(),
      mcpServersConfig: vi.fn().mockReturnValue({
        gateway: { type: 'http', url: 'http://localhost:8080/mcp' },
      }),
    };

    const activity = createClaudeSandboxActivity({
      name: 'gateway-task',
      runner: runner as any,
      gateway: gateway as any,
      sandbox: () => ({
        prompt: 'test',
        tools: ['search:*'],
      }),
    });

    const env = new MockActivityEnvironment();
    await env.run(activity, {});

    expect(gateway.mcpServersConfig).toHaveBeenCalledWith(['search:*']);
    const executeCall = runner.execute.mock.calls[0][0];
    expect(executeCall.input.mcpServers).toEqual({
      gateway: { type: 'http', url: 'http://localhost:8080/mcp' },
    });
  });
});
