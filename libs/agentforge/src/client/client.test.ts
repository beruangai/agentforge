import { getEventListeners } from 'node:events';
import { oc } from '@orpc/contract';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  awaitTask,
  createClient,
  type ProcedureClient,
  type TaskView,
} from './client.ts';

const base = {
  taskId: 'task',
  contextId: 'context',
  attempt: 1,
  image: 'image',
  runs: [],
};

describe('awaitTask', () => {
  it('polls to the end without leaving a listener on the signal', async () => {
    const signal = new AbortController().signal;
    const GetTask = vi
      .fn<ProcedureClient<unknown, string>['GetTask']>()
      .mockResolvedValueOnce({ ...base, state: 'TASK_STATE_WORKING' })
      .mockResolvedValueOnce({ ...base, state: 'TASK_STATE_WORKING' })
      .mockResolvedValueOnce({
        ...base,
        state: 'TASK_STATE_COMPLETED',
        output: 'done',
      });
    const started: TaskView<string> = {
      ...base,
      state: 'TASK_STATE_SUBMITTED',
    };
    const ended = await awaitTask({ SendMessage: vi.fn(), GetTask }, started, {
      runtimeSessionId: 'session',
      pollIntervalMilliseconds: 1,
      signal,
    });
    expect(ended).toMatchObject({ state: 'TASK_STATE_COMPLETED' });
    expect(GetTask).toHaveBeenCalledTimes(3);
    expect(getEventListeners(signal, 'abort')).toHaveLength(0);
  });

  it("throws the signal's reason when aborted mid-wait", async () => {
    const controller = new AbortController();
    const waiting = awaitTask(
      { SendMessage: vi.fn(), GetTask: vi.fn() },
      { ...base, state: 'TASK_STATE_WORKING' },
      { runtimeSessionId: 'session', signal: controller.signal },
    );
    const reason = new Error('the activity was cancelled');
    controller.abort(reason);
    await expect(waiting).rejects.toBe(reason);
  });
});

describe('createClient', () => {
  it('refuses a contract that would drop undeclared keys, whichever procedure holds it', () => {
    const transport = { call: vi.fn() };
    expect(() =>
      createClient(
        {
          kata: {
            Write: oc
              .input(z.strictObject({}))
              .output(z.strictObject({ cases: z.array(z.object({})) })),
          },
        },
        transport,
      ),
    ).toThrow(/kata\.Write\.output\.cases\[\] — z\.object/);
    expect(transport.call).not.toHaveBeenCalled();
  });
});

describe('GetTask', () => {
  const contract = {
    summarise: oc
      .input(z.strictObject({ text: z.string() }))
      .output(z.strictObject({ summary: z.string() })),
  };
  const answering = (task: unknown) =>
    createClient(contract, { call: async () => task });
  const wireTask = {
    id: 'task',
    contextId: 'context',
    status: { state: 'TASK_STATE_COMPLETED' },
    artifacts: [
      {
        artifactId: 'outcome',
        parts: [
          {
            data: {
              state: 'TASK_STATE_COMPLETED',
              output: { summary: 'short' },
            },
            mediaType: 'application/json',
          },
        ],
      },
    ],
    metadata: { attempt: 2, image: 'agent-image', runs: [] },
  };

  it('reads the typed output of a finished task off the wire', async () => {
    expect(
      await answering(wireTask).summarise.GetTask('task', {
        runtimeSessionId: 'session',
      }),
    ).toEqual({
      taskId: 'task',
      contextId: 'context',
      attempt: 2,
      image: 'agent-image',
      runs: [],
      state: 'TASK_STATE_COMPLETED',
      output: { summary: 'short' },
    });
  });

  it('reads a live task, which A2A sends without its empty artifacts', async () => {
    const { artifacts: _artifacts, ...live } = {
      ...wireTask,
      status: { state: 'TASK_STATE_WORKING' },
    };
    expect(
      await answering(live).summarise.GetTask('task', {
        runtimeSessionId: 'session',
      }),
    ).toMatchObject({ taskId: 'task', state: 'TASK_STATE_WORKING' });
  });

  it('refuses a task it cannot read rather than assume what is missing', async () => {
    await expect(
      answering({ ...wireTask, metadata: { runs: [] } }).summarise.GetTask(
        'task',
        { runtimeSessionId: 'session' },
      ),
    ).rejects.toThrow(/cannot read/);
    await expect(
      answering({
        ...wireTask,
        metadata: { attempt: 2, runs: [] },
      }).summarise.GetTask('task', { runtimeSessionId: 'session' }),
    ).rejects.toThrow(/cannot read[\s\S]*image/);
    await expect(
      answering({ ...wireTask, artifacts: [] }).summarise.GetTask('task', {
        runtimeSessionId: 'session',
      }),
    ).rejects.toThrow(/without an outcome/);
  });
});
