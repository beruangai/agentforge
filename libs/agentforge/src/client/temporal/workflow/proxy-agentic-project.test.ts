import { fileURLToPath } from 'node:url';
import { bundleWorkflowCode } from '@temporalio/worker';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CONTRACTS } from './__fixtures__/contract.ts';
import {
  type AgentActivityOptions,
  DEFAULT_ACTIVITY_OPTIONS,
  proxyAgenticProject,
} from './proxy-agentic-project.ts';

const { proxyActivities, scheduled } = vi.hoisted(() => {
  const scheduled = vi.fn(async (..._args: unknown[]) => 'output');
  return {
    scheduled,
    proxyActivities: vi.fn(
      (_options: unknown) =>
        new Proxy(
          {},
          {
            get: (_target, name) => (input: unknown, start: unknown) =>
              scheduled(name, input, start),
          },
        ),
    ),
  };
});
vi.mock('@temporalio/workflow', () => ({ proxyActivities }));

const START = { runtimeSessionId: 'session' };

describe('proxyAgenticProject', () => {
  beforeEach(() => {
    proxyActivities.mockClear();
    scheduled.mockClear();
  });

  it('schedules the activity named by the project, agent and procedure path', async () => {
    const goldenKata = proxyAgenticProject<typeof CONTRACTS>('goldenKata');
    await expect(
      goldenKata.grader.rubric.Grade({ kata: 'a kata' }, START),
    ).resolves.toBe('output');
    await goldenKata.writer.Write({ topic: 'recursion' }, START);
    expect(scheduled.mock.calls).toEqual([
      ['goldenKata.grader.rubric.Grade', { kata: 'a kata' }, START],
      ['goldenKata.writer.Write', { topic: 'recursion' }, START],
    ]);
  });

  it("merges the defaults under the caller's options", () => {
    proxyAgenticProject<typeof CONTRACTS>('goldenKata');
    proxyAgenticProject<typeof CONTRACTS>('goldenKata', {
      startToCloseTimeout: '2 hours',
      retry: { maximumAttempts: 3 },
    });
    expect(proxyActivities.mock.calls).toEqual([
      [DEFAULT_ACTIVITY_OPTIONS],
      [
        {
          heartbeatTimeout: '1 minute',
          startToCloseTimeout: '2 hours',
          cancellationType: 'WAIT_CANCELLATION_COMPLETED',
          retry: { maximumAttempts: 3 },
        },
      ],
    ]);
  });

  it("merges a call's options over the set's for that call alone", async () => {
    const goldenKata = proxyAgenticProject<typeof CONTRACTS>('goldenKata', {
      startToCloseTimeout: '2 hours',
    });
    await goldenKata.writer.Write({ topic: 'recursion' }, START, {
      startToCloseTimeout: '3 hours',
      summary: 'the long one',
    });
    await goldenKata.writer.Write({ topic: 'sums' }, START);
    expect(proxyActivities.mock.calls).toEqual([
      [{ ...DEFAULT_ACTIVITY_OPTIONS, startToCloseTimeout: '2 hours' }],
      [
        {
          ...DEFAULT_ACTIVITY_OPTIONS,
          startToCloseTimeout: '3 hours',
          summary: 'the long one',
        },
      ],
    ]);
    expect(scheduled.mock.calls).toEqual([
      ['goldenKata.writer.Write', { topic: 'recursion' }, START],
      ['goldenKata.writer.Write', { topic: 'sums' }, START],
    ]);
  });

  it('refuses an activity id or a task queue, for the set or a call', () => {
    for (const refused of [
      { activityId: 'write' },
      { taskQueue: 'elsewhere' },
    ]) {
      expect(() =>
        proxyAgenticProject<typeof CONTRACTS>(
          'goldenKata',
          refused as AgentActivityOptions,
        ),
      ).toThrow(/the goldenKata agents' options sets (activityId|taskQueue)/);
      const goldenKata = proxyAgenticProject<typeof CONTRACTS>('goldenKata');
      expect(() =>
        goldenKata.writer.Write(
          { topic: 'recursion' },
          START,
          refused as AgentActivityOptions,
        ),
      ).toThrow(/the call to goldenKata\.writer\.Write sets/);
    }
    expect(scheduled).not.toHaveBeenCalled();
    // Checked, never run.
    void (() =>
      // @ts-expect-error — the activity id keys the agent's task
      proxyAgenticProject<typeof CONTRACTS>('goldenKata', { activityId: 'x' }));
  });

  it('is not thenable at any level, so a namespace can be awaited or returned', () => {
    const goldenKata = proxyAgenticProject<typeof CONTRACTS>('goldenKata');
    expect((goldenKata as { then?: unknown }).then).toBeUndefined();
    expect((goldenKata.writer as { then?: unknown }).then).toBeUndefined();
  });

  it('refuses a procedure the contracts lack, or a wrong input, at compile time', () => {
    const goldenKata = proxyAgenticProject<typeof CONTRACTS>('goldenKata');
    // @ts-expect-error — no such procedure
    void goldenKata.writer.Rewrite;
    // @ts-expect-error — the input's field is `topic`
    void goldenKata.writer.Write({ subject: 'recursion' }, START);
    // @ts-expect-error — the call's routing is required
    void goldenKata.writer.Write({ topic: 'recursion' });
  });
});

describe('a workflow bundle', () => {
  it("holds none of the contracts' or AgentForge's other code", async () => {
    const { code } = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(
        new URL('./__fixtures__/workflow.ts', import.meta.url),
      ),
      logger: {
        log: () => undefined,
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });
    const modules = new Set(
      [...code.matchAll(/"(\.\.?\/[^"\s]+)"/g)].map((match) => match[1]),
    );
    expect(
      [...modules].filter((module) => module?.startsWith('./src/')).sort(),
    ).toEqual([
      './src/client/temporal/workflow/__fixtures__/workflow.ts',
      './src/client/temporal/workflow/proxy-agentic-project.ts',
    ]);
    expect(
      [...modules].filter((module) => /\/(zod|@orpc)\//.test(module ?? '')),
    ).toEqual([]);
  }, 60_000);
});
