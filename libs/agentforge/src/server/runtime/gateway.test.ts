import { SendMessageRequest, type Task } from '@a2a-js/sdk';
import {
  type DefaultRequestHandler,
  JsonRpcTransportHandler,
  type ServerCallContext,
} from '@a2a-js/sdk/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_SESSION_HEADER } from '#core/contract/envelope.ts';
import {
  type StartRefusal,
  startRefusalOf,
} from '#core/contract/start-refusal.ts';
import { cause } from '#core/contract/task.ts';
import { TASK_INPUT_CAP_BYTES } from '#core/task-table.ts';
import { finishedTask, newTask, outcomeOf } from './a2a-task.ts';
import {
  ADMISSION_METADATA_KEY,
  type Admission,
  type TaskProcessExecutor,
} from './executor.ts';
import { createGateway } from './gateway.ts';
import { StartRefusalError } from './start-refusal-error.ts';
import type { DynamoDBTaskStore } from './task-store.ts';

function gateway(
  options: {
    stopping?: boolean;
    liveCount?: number;
    continuityKeyRetryAfterSeconds?: number;
    stoppingRefusal?: boolean;
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
    liveCount: options.liveCount ?? 0,
    continuityKeyRetryAfterSeconds: vi.fn(
      () => options.continuityKeyRetryAfterSeconds,
    ),
    takeStoppingRefusal: vi.fn(() => options.stoppingRefusal ?? false),
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

const continuing = withEnvelope({ continuityKey: 'thread' });

function withEnvelope(fields: Record<string, unknown>): SendMessageRequest {
  const changed = structuredClone(request);
  const [part] = changed.message?.parts ?? [];
  if (part?.content?.$case !== 'data') throw new Error('no envelope');
  part.content.value = { ...part.content.value, ...fields };
  return changed;
}

/** A task still running under the request's key, in its session. */
const running = newTask({
  id: 'running',
  contextId: 'context',
  state: 'TASK_STATE_WORKING',
  metadata: { runtimeSessionId: 'session', attempt: 1 },
});

async function refusalOf(
  sent: Promise<unknown>,
): Promise<{ refusal: StartRefusal; retryAfterSeconds: number }> {
  const error: unknown = await sent.then(
    () => {
      throw new Error('the start was not refused');
    },
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof StartRefusalError)) throw error;
  return { refusal: error.refusal, retryAfterSeconds: error.retryAfterSeconds };
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it.each([
    {
      refusal: 'CONTAINER_STOPPING',
      retryAfterSeconds: 5,
      options: { stopping: true },
      sent: request,
    },
    {
      refusal: 'ADMISSION_LIMIT',
      retryAfterSeconds: 600,
      options: { liveCount: 4 },
      sent: request,
    },
    {
      refusal: 'CONTINUITY_KEY_RUNNING',
      retryAfterSeconds: 42,
      options: { continuityKeyRetryAfterSeconds: 42 },
      sent: continuing,
    },
  ] as const)(
    'refuses a start in-band for $refusal, creating no task and binding no key',
    async ({ refusal, retryAfterSeconds, options, sent }) => {
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { handler, inner, store } = gateway(options);
      expect(await refusalOf(handler.sendMessage(sent, context))).toEqual({
        refusal,
        retryAfterSeconds,
      });
      expect(inner.sendMessage).not.toHaveBeenCalled();
      expect(store.save).not.toHaveBeenCalled();
      expect(store.bindKey).not.toHaveBeenCalled();
      expect(warned).toHaveBeenCalledOnce();
      expect(String(warned.mock.lastCall?.[0])).toMatch(
        new RegExp(`${refusal}: .+; retry after ${retryAfterSeconds}s`),
      );
    },
  );

  it('asks the continuity key of the start it refuses', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, executor } = gateway({
      continuityKeyRetryAfterSeconds: 42,
    });
    await refusalOf(handler.sendMessage(continuing, context));
    expect(executor.continuityKeyRetryAfterSeconds).toHaveBeenCalledWith(
      'thread',
    );
  });

  it('attaches a start whose key names a live task, while stopping and full', async () => {
    const { handler, inner } = gateway({
      stopping: true,
      liveCount: 4,
      existing: running,
    });
    expect(await handler.sendMessage(request, context)).toBe(running);
    expect(inner.sendMessage).not.toHaveBeenCalled();
  });

  it('refuses a start the executor refused as the stop began, leaving its key unbound', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler, inner, store, executor } = gateway({
      stoppingRefusal: true,
    });
    expect(await refusalOf(handler.sendMessage(request, context))).toEqual({
      refusal: 'CONTAINER_STOPPING',
      retryAfterSeconds: 5,
    });
    expect(executor.takeStoppingRefusal).toHaveBeenCalledWith(
      admissionOf(inner).startId,
    );
    expect(store.bindKey).not.toHaveBeenCalled();
    // It spawned nothing: there is nothing to stop.
    expect(executor.stopFailedStart).not.toHaveBeenCalled();
  });

  it('answers a refusal as JSON-RPC carrying the agentforge ErrorInfo', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { handler } = gateway({ liveCount: 4 });
    const response = await new JsonRpcTransportHandler(handler).handle(
      {
        jsonrpc: '2.0',
        id: 'call',
        method: 'SendMessage',
        params: SendMessageRequest.toJSON(request) as Record<string, unknown>,
      },
      context,
    );
    if (!('error' in response)) {
      throw new Error(`answered without an error: ${JSON.stringify(response)}`);
    }
    const error = response.error as { code: number; data?: unknown };
    expect(error.code).toBe(-32603);
    expect(startRefusalOf(error.data)).toEqual({
      refusal: 'ADMISSION_LIMIT',
      retryAfterSeconds: 600,
    });
  });

  it('refuses a start over the input cap before anything runs, recording neither it nor its metadata and tags', async () => {
    const { handler, inner, store } = gateway();
    const oversize = structuredClone(request);
    const [part] = oversize.message?.parts ?? [];
    if (part?.content?.$case !== 'data') throw new Error('no envelope');
    part.content.value = {
      ...part.content.value,
      metadata: { note: 'x'.repeat(TASK_INPUT_CAP_BYTES) },
      tags: { kind: 'oversize' },
    };
    const refused = (await handler.sendMessage(oversize, context)) as Task;
    expect(inner.sendMessage).not.toHaveBeenCalled();
    expect(outcomeOf(refused)).toMatchObject({
      state: 'TASK_STATE_REJECTED',
      reason: expect.stringMatching(
        new RegExp(`is \\d+ bytes; the cap is ${TASK_INPUT_CAP_BYTES}`),
      ),
    });
    const saved = store.save.mock.lastCall as unknown as [Task];
    expect(saved[0].metadata).toMatchObject({ metadata: {}, tags: {} });
    expect(saved[0].history).toEqual([]);
  });

  it('tells a new attempt how the last one failed, without its payload', async () => {
    const { handler, inner } = gateway({
      existing: finishedTask(
        newTask({
          id: 'earlier',
          contextId: 'context',
          state: 'TASK_STATE_SUBMITTED',
          metadata: { runtimeSessionId: 'session', attempt: 1 },
        }),
        {
          state: 'TASK_STATE_FAILED',
          cause: {
            ...cause('OUTPUT_INVALID', 'did not conform'),
            payload: { answer: 'unconforming' },
          },
        },
      ),
    });
    await handler.sendMessage(request, context);
    const { priorAttempt } = admissionOf(inner);
    expect(priorAttempt).toMatchObject({
      taskId: 'earlier',
      cause: { code: 'OUTPUT_INVALID' },
    });
    expect(priorAttempt?.cause).not.toHaveProperty('payload');
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
