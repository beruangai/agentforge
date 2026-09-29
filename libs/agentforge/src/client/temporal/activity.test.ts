import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { DefaultLogger } from '@temporalio/worker';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartRefusal } from '#core/contract/start-refusal.ts';
import type { ProcedureClient, TaskView } from '../client.ts';
import { StartRefusedError } from '../transport.ts';
import { procedureActivity } from './activity.ts';

/** Vitest's fake timers do not reach `node:timers/promises`; this routes its waits through the global timers they fake. */
vi.mock('node:timers/promises', () => ({
  setTimeout: (
    milliseconds: number,
    value: unknown,
    options?: { signal?: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      if (signal?.aborted) return reject(signal.reason);
      const timer = globalThis.setTimeout(() => resolve(value), milliseconds);
      signal?.addEventListener(
        'abort',
        () => {
          globalThis.clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
}));

const sendMessage = vi.fn<ProcedureClient<string, string>['SendMessage']>();
const cancelTask = vi.fn();
const procedure: ProcedureClient<string, string> = {
  SendMessage: sendMessage,
  GetTask: vi.fn(),
};
const activity = procedureActivity(procedure, {
  runtimeSessionId: () => 'session',
  start: () => ({ continuityKey: 'continuity' }),
  cancelTask,
});

const TASK = { taskId: 'task', contextId: 'context', attempt: 1, runs: [] };
const COMPLETED: TaskView<string> = {
  ...TASK,
  state: 'TASK_STATE_COMPLETED',
  output: 'done',
};

/** Built when thrown, so its `retryAfter` counts from the fake clock's now. */
function refused(refusal: StartRefusal, retryAfterSeconds: number) {
  return async (): Promise<never> => {
    throw new StartRefusedError('SendMessage', -32603, `refused: ${refusal}`, {
      refusal,
      retryAfterSeconds,
    });
  };
}

function environment() {
  const env = new MockActivityEnvironment(
    {
      activityId: '1',
      workflowExecution: { workflowId: 'workflow', runId: 'run' },
    },
    // The failures here are the point; the worker logs each one as a warning.
    { logger: new DefaultLogger('ERROR') },
  );
  const heartbeats: unknown[] = [];
  env.on('heartbeat', (details) => heartbeats.push(details));
  return { env, heartbeats };
}

describe('procedureActivity', () => {
  beforeEach(() => {
    sendMessage.mockReset();
    cancelTask.mockReset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits out a refusal inside the budget, heartbeating, and starts again under the same key', async () => {
    sendMessage
      .mockImplementationOnce(refused('ADMISSION_LIMIT', 600))
      .mockResolvedValueOnce(COMPLETED);
    const { env, heartbeats } = environment();
    const running = env.run(activity, 'input');
    await vi.advanceTimersByTimeAsync(599_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(running).resolves.toBe('done');
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]).toEqual(sendMessage.mock.calls[0]);
    expect(sendMessage.mock.calls[0]?.[1]).toMatchObject({
      idempotencyKey: 'workflow/run/1',
      continuityKey: 'continuity',
    });
    const waiting = heartbeats.filter(
      (details) =>
        (details as { refusal?: string }).refusal === 'ADMISSION_LIMIT',
    );
    expect(waiting.length).toBe(120);
  });

  it('ends the wait at once when the activity is cancelled, with nothing to cancel', async () => {
    sendMessage.mockImplementationOnce(refused('CONTAINER_STOPPING', 5));
    const { env } = environment();
    const running = env.run(activity, 'input');
    const settled = expect(running).rejects.toBeInstanceOf(CancelledFailure);
    await vi.advanceTimersByTimeAsync(1_000);
    env.cancel();
    await settled;
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(cancelTask).not.toHaveBeenCalled();
  });

  it('fails retryable past the budget, delaying the next attempt to the refusal', async () => {
    sendMessage
      .mockImplementationOnce(refused('ADMISSION_LIMIT', 600))
      .mockImplementationOnce(refused('ADMISSION_LIMIT', 600));
    const { env } = environment();
    const running = env.run(activity, 'input');
    const settled = expect(running).rejects.toMatchObject({
      type: 'ADMISSION_LIMIT',
      nonRetryable: false,
      nextRetryDelay: 600_000,
    });
    await vi.advanceTimersByTimeAsync(600_000);
    await settled;
    await expect(running).rejects.toBeInstanceOf(ApplicationFailure);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps TASK_STATE_REJECTED non-retryable', async () => {
    sendMessage.mockResolvedValueOnce({
      ...TASK,
      state: 'TASK_STATE_REJECTED',
      reason: 'contract hash mismatch',
    });
    const { env } = environment();
    await expect(env.run(activity, 'input')).rejects.toMatchObject({
      type: 'TASK_STATE_REJECTED',
      nonRetryable: true,
    });
  });
});
