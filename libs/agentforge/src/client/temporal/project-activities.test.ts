import { oc } from '@orpc/contract';
import { MockActivityEnvironment } from '@temporalio/testing';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ProcedureClient, TaskView } from '../client.ts';
import { projectActivities } from './project-activities.ts';

const CONTRACTS = {
  writer: {
    Write: oc.input(z.object({ topic: z.string() })).output(z.string()),
  },
  grader: {
    rubric: {
      Grade: oc.input(z.object({ kata: z.string() })).output(z.number()),
    },
  },
};

const TASK = { taskId: 'task', contextId: 'context', attempt: 1, runs: [] };

function answering<Output>(output: Output): ProcedureClient<never, Output> {
  return {
    SendMessage: vi.fn(
      async (): Promise<TaskView<Output>> => ({
        ...TASK,
        state: 'TASK_STATE_COMPLETED',
        output,
      }),
    ),
    GetTask: vi.fn(),
  };
}

const CLIENT = {
  writer: { Write: answering('a kata'), CancelTask: vi.fn() },
  grader: { rubric: { Grade: answering(7) }, CancelTask: vi.fn() },
};

function run(activity: unknown, input: unknown) {
  return new MockActivityEnvironment({
    activityId: '1',
    workflowExecution: { workflowId: 'workflow', runId: 'run' },
  }).run(activity as (...args: unknown[]) => Promise<unknown>, input, {
    runtimeSessionId: 'session',
  });
}

describe('projectActivities', () => {
  const activities = projectActivities('goldenKata', CONTRACTS, CLIENT);

  it('names one activity per procedure, nested namespaces included', () => {
    expect(Object.keys(activities).sort()).toEqual([
      'goldenKata.grader.rubric.Grade',
      'goldenKata.writer.Write',
    ]);
  });

  it("routes each to its agent's procedure client", async () => {
    await expect(
      run(activities['goldenKata.writer.Write'], { topic: 'recursion' }),
    ).resolves.toBe('a kata');
    await expect(
      run(activities['goldenKata.grader.rubric.Grade'], { kata: 'a kata' }),
    ).resolves.toBe(7);
    expect(CLIENT.grader.rubric.Grade.SendMessage).toHaveBeenCalledWith(
      { kata: 'a kata' },
      expect.objectContaining({
        runtimeSessionId: 'session',
        idempotencyKey: 'workflow/run/1',
      }),
    );
  });

  it('requires a client for every agent of the contracts', () => {
    const { grader: _grader, ...writerOnly } = CLIENT;
    expect(() =>
      // @ts-expect-error — the grader's client is missing
      projectActivities('goldenKata', CONTRACTS, writerOnly),
    ).toThrow("no client for agent 'grader'");
  });
});
