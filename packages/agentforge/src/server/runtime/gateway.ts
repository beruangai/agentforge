import { randomUUIDv7 } from 'node:crypto';
import type { Message, SendMessageRequest, Task } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type {
  A2ARequestHandler,
  DefaultRequestHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { RUNTIME_SESSION_HEADER } from '#core/contract/envelope.ts';
import { isTerminal, type PriorAttempt } from '#core/contract/task.ts';
import {
  finishedTask,
  newTask,
  outcomeOf,
  readEnvelope,
  stateOf,
} from './a2a-task.ts';
import {
  ADMISSION_METADATA_KEY,
  type Admission,
  CONTAINER_STOPPING_REASON,
  type TaskProcessExecutor,
  taskMetadata,
} from './executor.ts';
import type { DynamoDBTaskStore } from './task-store.ts';

export interface GatewayConfig {
  readonly inner: DefaultRequestHandler;
  readonly executor: TaskProcessExecutor;
  readonly store: DynamoDBTaskStore;
  /** Tasks this container runs at once; a start beyond it is rejected, never queued. */
  readonly admissionLimit: number;
}

/**
 * The request handler in front of the A2A SDK's. The SDK mints a task id
 * before its executor runs, so everything that decides whether a start is a
 * new task — idempotency, admission, continuity — happens here, before
 * delegating. A cancel always reaches the executor, never only the SDK's
 * default path. A container that has begun to stop refuses every start.
 */
export function createGateway(config: GatewayConfig): A2ARequestHandler {
  const pendingByKey = new Map<string, Promise<unknown>>();

  async function sendMessage(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<Message | Task> {
    let envelope: ReturnType<typeof readEnvelope>;
    try {
      envelope = readEnvelope(params.message);
    } catch (error) {
      throw new RequestMalformedError(
        `not an AgentForge start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const sessionHeader = headerOf(context, RUNTIME_SESSION_HEADER);
    if (sessionHeader === undefined) {
      throw new RequestMalformedError(
        `the ${RUNTIME_SESSION_HEADER} header is required`,
      );
    }
    const runtimeSessionId: string = sessionHeader;
    // One start per key at a time in this container; the store's conditional
    // write settles a race across containers.
    const key = envelope.idempotencyKey;
    const previous = pendingByKey.get(key) ?? Promise.resolve();
    const current = previous.then(
      () => start(),
      () => start(),
    );
    pendingByKey.set(key, current);
    try {
      return await current;
    } finally {
      if (pendingByKey.get(key) === current) pendingByKey.delete(key);
    }

    async function start(): Promise<Message | Task> {
      const existingId = await config.store.taskIdForKey(key);
      const existing =
        existingId === undefined
          ? undefined
          : await config.store.load(existingId);
      let attempt = 1;
      let priorAttempt: PriorAttempt | undefined;
      if (existing !== undefined) {
        // A key is one logical execution, and an execution lives in one
        // session: reuse across sessions is a caller's bug, never an attach.
        const existingSession = existing.metadata?.runtimeSessionId;
        if (existingSession !== runtimeSessionId) {
          throw new RequestMalformedError(
            `idempotency key "${key}" names task ${existing.id} in another runtime session`,
          );
        }
        const state = stateOf(existing);
        // A live or completed task is the answer to a retry: attach to it.
        if (!isTerminal(state) || state === 'TASK_STATE_COMPLETED')
          return existing;
        const outcome = outcomeOf(existing);
        const existingAttempt = existing.metadata?.attempt;
        if (typeof existingAttempt !== 'number') {
          throw new Error(`task ${existing.id} is stored without its attempt`);
        }
        attempt = existingAttempt + 1;
        priorAttempt = {
          taskId: existing.id,
          state,
          ...(outcome?.state === 'TASK_STATE_FAILED'
            ? { cause: outcome.cause }
            : {}),
        };
      }
      const contextId = params.message?.contextId || randomUUIDv7();
      const admission: Admission = {
        runtimeSessionId,
        attempt,
        priorAttempt,
        startId: randomUUIDv7(),
      };
      if (config.executor.stopping) {
        return await reject(contextId, admission, CONTAINER_STOPPING_REASON);
      }
      if (config.executor.liveCount >= config.admissionLimit) {
        return await reject(
          contextId,
          admission,
          `the container is at its admission limit of ${config.admissionLimit} tasks`,
        );
      }
      if (
        envelope.continuityKey !== undefined &&
        config.executor.hasLiveContinuityKey(envelope.continuityKey)
      ) {
        return await reject(
          contextId,
          admission,
          `a task under continuity key "${envelope.continuityKey}" is already running`,
        );
      }
      const message = params.message;
      if (message === undefined)
        throw new RequestMalformedError('the request carries no message');
      try {
        const started = await config.inner.sendMessage(
          {
            ...params,
            message: {
              ...message,
              contextId,
              metadata: {
                ...message.metadata,
                [ADMISSION_METADATA_KEY]: admission,
              },
            },
            configuration: {
              acceptedOutputModes: [],
              taskPushNotificationConfig: undefined,
              ...params.configuration,
              returnImmediately: true,
            },
          },
          context,
        );
        if (!('status' in started)) {
          throw new Error(
            'the executor answered a start with a message, not a task',
          );
        }
        await config.store.bindKey(key, started.id, existingId);
        return started;
      } catch (error) {
        // The task process may already run, and the caller, told the start
        // failed, holds nothing naming it: a retry would run beside it.
        await config.executor.stopFailedStart(admission.startId);
        throw error;
      }
    }

    /** A refusal is a task, so the caller gets a typed reason rather than an error string. */
    async function reject(
      contextId: string,
      admission: Admission,
      reason: string,
    ): Promise<Task> {
      const task = finishedTask(
        newTask({
          id: randomUUIDv7(),
          contextId,
          state: 'TASK_STATE_SUBMITTED',
          metadata: taskMetadata(envelope, admission),
        }),
        { state: 'TASK_STATE_REJECTED', reason },
      );
      await config.store.save(task);
      return task;
    }
  }

  const cancelTask: A2ARequestHandler['cancelTask'] = async (
    params,
    context,
  ) => {
    if (config.executor.isLive(params.id)) {
      await config.executor.stop(params.id, 'CANCEL');
    }
    // Not running here: it is finished, or its container is gone and its
    // lease will say so. Either way the stored task is the answer.
    return await config.inner.getTask({ ...params, historyLength: 0 }, context);
  };

  return new Proxy(config.inner, {
    get(target, property, receiver) {
      if (property === 'sendMessage') return sendMessage;
      if (property === 'cancelTask') return cancelTask;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function headerOf(
  context: ServerCallContext,
  name: string,
): string | undefined {
  const headers = context.state.get('headers');
  if (typeof headers !== 'object' || headers === null) return undefined;
  const value = (headers as Record<string, unknown>)[name];
  if (Array.isArray(value)) return value.join(',');
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
