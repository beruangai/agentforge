import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Task } from '@a2a-js/sdk';
import type { ExecutionEventBus, RequestContext } from '@a2a-js/sdk/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Envelope } from '#core/contract/envelope.ts';
import { outcomeOfArtifacts } from '#core/contract/task.ts';
import {
  ADMISSION_METADATA_KEY,
  type Admission,
  type ExecutorConfig,
  TaskProcessExecutor,
} from './executor.ts';

const SCRIPTED_TASK_PROCESS = join(
  import.meta.dirname,
  '__fixtures__',
  'scripted-task-process.ts',
);

function executor(overrides: Partial<ExecutorConfig> = {}) {
  const store = {
    save: vi.fn<ExecutorConfig['store']['save']>(async () => undefined),
    renewLease: vi.fn<ExecutorConfig['store']['renewLease']>(async () => true),
  };
  const metrics = { count: vi.fn(), flush: async () => undefined };
  const config: ExecutorConfig = {
    taskCommand: [process.execPath, SCRIPTED_TASK_PROCESS],
    defaultTimeBudgetSeconds: 60,
    graceMilliseconds: 300,
    store,
    metrics,
    ...overrides,
  };
  return { executor: new TaskProcessExecutor(config), store, metrics };
}

let started = 0;
/** Starts a task scripted as `script`; resolves once the executor is done with it. */
function start(
  target: TaskProcessExecutor,
  script: string,
  envelope: Partial<Envelope> = {},
) {
  started += 1;
  const taskId = `task-${started}`;
  const admission: Admission = {
    runtimeSessionId: 'session',
    attempt: 1,
    priorAttempt: undefined,
    startId: `start-${started}`,
  };
  const requestContext = {
    taskId,
    contextId: 'context',
    userMessage: {
      messageId: 'message',
      contextId: 'context',
      parts: [
        {
          content: {
            $case: 'data',
            value: {
              procedure: 'scripted',
              contractHash: 'hash',
              input: { script },
              idempotencyKey: `key-${started}`,
              ...envelope,
            },
          },
          filename: '',
          mediaType: '',
          metadata: undefined,
        },
      ],
      metadata: { [ADMISSION_METADATA_KEY]: admission },
    },
  } as unknown as RequestContext;
  const eventBus = {
    publish: vi.fn(),
    finished: vi.fn(),
  } as unknown as ExecutionEventBus;
  const done = target.execute(requestContext, eventBus);
  return { taskId, startId: admission.startId, done, eventBus };
}

/** The outcome of the task the executor saved last. */
function savedOutcome(store: ReturnType<typeof executor>['store']) {
  const task = store.save.mock.lastCall?.[0];
  if (task === undefined) throw new Error('nothing was saved');
  return outcomeOfArtifacts(
    (Task.toJSON(task) as { artifacts?: unknown }).artifacts,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('TaskProcessExecutor', () => {
  it('records the outcome the task process reports, with its runs', async () => {
    const { executor: target, store } = executor();
    await start(target, 'REPORT').done;
    expect(savedOutcome(store)).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { reported: true },
    });
    expect(store.save.mock.lastCall?.[0].metadata?.runs).toHaveLength(1);
    expect(target.liveCount).toBe(0);
  });

  it('keeps an outcome reported before a stop: the stop only ends the process', async () => {
    const stderr = vi.spyOn(process.stderr, 'write');
    const { executor: target, store } = executor({ graceMilliseconds: 5_000 });
    const task = start(target, 'REPORT_THEN_LINGER');
    await vi.waitFor(() =>
      expect(
        stderr.mock.calls.some(([chunk]) =>
          String(chunk).includes('scripted-task-process: reported'),
        ),
      ).toBe(true),
    );
    await delay(100);
    await target.stop(task.taskId, 'CANCEL');
    await task.done;
    expect(savedOutcome(store)).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { reported: true },
    });
  });

  it('records the stop when it came first, whatever the process then reports', async () => {
    const { executor: target, store } = executor();
    const task = start(target, 'WAIT');
    await target.stop(task.taskId, 'CANCEL');
    await task.done;
    expect(savedOutcome(store)).toEqual({ state: 'TASK_STATE_CANCELED' });
  });

  it('counts and arms a stop once, however many arrive', async () => {
    const { executor: target, store, metrics } = executor();
    const task = start(target, 'IGNORE_CANCEL');
    const cancelled = target.stop(task.taskId, 'CANCEL');
    await target.shutdown();
    await cancelled;
    await task.done;
    expect(savedOutcome(store)).toEqual({ state: 'TASK_STATE_CANCELED' });
    expect(metrics.count.mock.calls.map(([metric]) => metric)).toEqual([
      'TasksKilledAfterGrace',
    ]);
  });

  it('survives a task process that cannot be spawned', async () => {
    const { executor: target, store } = executor({
      taskCommand: ['/nonexistent/agentforge-task-process'],
    });
    await start(target, 'REPORT').done;
    expect(savedOutcome(store)).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'EXECUTION_ERROR',
        message: expect.stringMatching(/could not start/),
      },
    });
    expect(target.liveCount).toBe(0);
  });

  it('refuses a missing or empty task command', () => {
    expect(() => executor({ taskCommand: [] })).toThrow(/needs a command/);
    expect(() => executor({ taskCommand: [''] })).toThrow(/needs a command/);
  });

  it('logs a message outside the protocol rather than trusting it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { executor: target, store } = executor();
    await start(target, 'SEND_GARBAGE').done;
    expect(
      logged.mock.calls.some(([line]) =>
        String(line).includes('outside the protocol'),
      ),
    ).toBe(true);
    expect(savedOutcome(store)).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
    });
  });

  it('stops a task whose lease a reader already derived lost, and leaves the loss as the record', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { executor: target, store } = executor();
    store.renewLease.mockResolvedValue(false);
    const task = start(target, 'WAIT');
    await vi.advanceTimersByTimeAsync(20_000);
    await task.done;
    expect(store.renewLease).toHaveBeenCalledWith(task.taskId);
    expect(store.save).not.toHaveBeenCalled();
    expect(task.eventBus.finished).toHaveBeenCalled();
    expect(target.liveCount).toBe(0);
  });

  it('stops the task a failed start spawned', async () => {
    const { executor: target, store } = executor();
    const task = start(target, 'WAIT');
    await target.stopFailedStart(task.startId);
    await task.done;
    expect(savedOutcome(store)).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'EXECUTION_ERROR' },
    });
  });

  it('refuses a start once the container is stopping, spawning nothing, and tells the gateway once', async () => {
    const { executor: target, store } = executor({
      taskCommand: ['/nonexistent/agentforge-task-process'],
    });
    await target.shutdown();
    const task = start(target, 'REPORT');
    // Recorded before the first await, so before the SDK can answer the start.
    expect(target.takeStoppingRefusal(task.startId)).toBe(true);
    expect(target.takeStoppingRefusal(task.startId)).toBe(false);
    await task.done;
    expect(savedOutcome(store)).toMatchObject({
      state: 'TASK_STATE_REJECTED',
    });
  });

  it("gives a continuity key the ceiling of its holder's remaining time budget, at least a second", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { executor: target } = executor();
    const task = start(target, 'WAIT', {
      continuityKey: 'thread',
      timeBudgetSeconds: 60,
    });
    expect(target.continuityKeyRetryAfterSeconds('thread')).toBe(60);
    vi.advanceTimersByTime(30_200);
    expect(target.continuityKeyRetryAfterSeconds('thread')).toBe(30);
    vi.advanceTimersByTime(40_000);
    expect(target.continuityKeyRetryAfterSeconds('thread')).toBe(1);
    expect(target.continuityKeyRetryAfterSeconds('another')).toBeUndefined();
    await target.stop(task.taskId, 'CANCEL');
    await task.done;
    expect(target.continuityKeyRetryAfterSeconds('thread')).toBeUndefined();
  });
});
