import type { SendMessageRequest, Task } from '@a2a-js/sdk';
import type {
  DefaultRequestHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { describe, expect, it, vi } from 'vitest';
import { RUNTIME_SESSION_HEADER } from '#core/contract/envelope.ts';
import { finishedTask, newTask, outcomeOf } from './a2a-task.ts';
import {
  ADMISSION_METADATA_KEY,
  type Admission,
  type TaskProcessExecutor,
} from './executor.ts';
import { createGateway } from './gateway.ts';
import type { DynamoDBTaskStore } from './task-store.ts';

function gateway(
  options: {
    stopping?: boolean;
    existing?: Task;
    sendMessage?: DefaultRequestHandler['sendMessage'];
    bindKey?: DynamoDBTaskStore['bindKey'];
  } = {},
) {
  const store = {
    taskIdForKey: vi.fn(async () => options.existing?.id),
    load: vi.fn(async () => options.existing),
    save: vi.fn(async () => undefined),
    bindKey: vi.fn(options.bindKey ?? (async () => undefined)),
  };
  const executor = {
    stopping: options.stopping ?? false,
    liveCount: 0,
    hasLiveContinuityKey: () => false,
    stopFailedStart: vi.fn(async () => undefined),
  };
  const inner = {
    sendMessage: vi.fn(
      options.sendMessage ??
        (async () =>
          newTask({
            id: 'started',
            contextId: 'context',
            state: 'TASK_STATE_SUBMITTED',
            metadata: {},
          })),
    ),
  };
  const handler = createGateway({
    inner: inner as unknown as DefaultRequestHandler,
    executor: executor as unknown as TaskProcessExecutor,
    store: store as unknown as DynamoDBTaskStore,
    admissionLimit: 4,
  });
  return { handler, store, executor, inner };
}

const context = {
  state: new Map([['headers', { [RUNTIME_SESSION_HEADER]: 'session' }]]),
} as unknown as ServerCallContext;

const request = {
  message: {
    messageId: 'message',
    contextId: 'context',
    parts: [
      {
        content: {
          $case: 'data',
          value: {
            procedure: 'summarise',
            contractHash: 'hash',
            input: {},
            idempotencyKey: 'key',
          },
        },
        filename: '',
        mediaType: '',
        metadata: undefined,
      },
    ],
  },
} as unknown as SendMessageRequest;

function admissionOf(inner: ReturnType<typeof gateway>['inner']): Admission {
  const sent = inner.sendMessage.mock.lastCall?.[0];
  return sent?.message?.metadata?.[ADMISSION_METADATA_KEY] as Admission;
}

describe('the gateway', () => {
  it('stops what a start spawned when the SDK then fails it', async () => {
    const { handler, inner, executor } = gateway({
      sendMessage: async () => {
        throw new Error('the SUBMITTED save failed');
      },
    });
    await expect(handler.sendMessage(request, context)).rejects.toThrow(
      /SUBMITTED save failed/,
    );
    expect(executor.stopFailedStart).toHaveBeenCalledWith(
      admissionOf(inner).startId,
    );
  });

  it('stops what a start spawned when its key cannot be bound', async () => {
    const { handler, inner, executor } = gateway({
      bindKey: async () => {
        throw new Error('another container bound the key');
      },
    });
    await expect(handler.sendMessage(request, context)).rejects.toThrow(
      /another container/,
    );
    expect(executor.stopFailedStart).toHaveBeenCalledWith(
      admissionOf(inner).startId,
    );
  });

  it('refuses a start once the container is stopping, recording what the client reads', async () => {
    const { handler, inner } = gateway({ stopping: true });
    const refused = (await handler.sendMessage(request, context)) as Task;
    expect(inner.sendMessage).not.toHaveBeenCalled();
    expect(outcomeOf(refused)).toMatchObject({
      state: 'TASK_STATE_REJECTED',
      reason: expect.stringMatching(/stopping/),
    });
    expect(refused.metadata).toMatchObject({
      runtimeSessionId: 'session',
      attempt: 1,
      runs: [],
    });
  });

  it('refuses to guess the attempt of a stored task without one', async () => {
    const { handler } = gateway({
      existing: finishedTask(
        newTask({
          id: 'earlier',
          contextId: 'context',
          state: 'TASK_STATE_SUBMITTED',
          metadata: { runtimeSessionId: 'session' },
        }),
        { state: 'TASK_STATE_CANCELED' },
      ),
    });
    await expect(handler.sendMessage(request, context)).rejects.toThrow(
      /without its attempt/,
    );
  });
});
