import { randomUUIDv7 } from 'node:crypto';
import type { Message, SendMessageRequest, Task } from '@a2a-js/sdk';
import { RequestMalformedError } from '@a2a-js/sdk/errors';
import type {
  A2ARequestHandler,
  DefaultRequestHandler,
  ServerCallContext,
} from '@a2a-js/sdk/server';
import { RUNTIME_SESSION_HEADER } from '#core/contract/envelope.ts';
import type { StartRefusal } from '#core/contract/start-refusal.ts';
import {
  type Cause,
  isTerminal,
  type PriorAttempt,
} from '#core/contract/task.ts';
import { TASK_INPUT_CAP_BYTES } from '#core/task-table.ts';
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
import { StartRefusalError } from './start-refusal-error.ts';
import type { DynamoDBTaskStore } from './task-store.ts';

/** The platform routes a stopped session's next call to a fresh container within about half a second. */
const CONTAINER_STOPPING_RETRY_AFTER_SECONDS = 5;
/** Fixed until a consumer needs another value. */
const ADMISSION_LIMIT_RETRY_AFTER_SECONDS = 600;

export interface GatewayConfig {
  readonly inner: DefaultRequestHandler;
  readonly executor: TaskProcessExecutor;
  readonly store: DynamoDBTaskStore;
  /** Tasks this container runs at once; a start beyond it is refused, never queued. */
  readonly admissionLimit: number;
  /** The image this server runs in, recorded on a start rejected here as on any task. */
  readonly image: string;
}

/**
 * The request handler in front of the A2A SDK's. The SDK mints a task id
 * before its executor runs, so everything that decides whether a start is a
 * new task — idempotency, admission, continuity — happens here, before
 * delegating. A cancel always reaches the executor, never only the SDK's
 * default path. A container that has begun to stop refuses every start.
 *
 * A start that could run later is refused in-band with when to retry, and
 * leaves no task and no key bound; what can never succeed is a rejected task.
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
          // Without its payload, which could take the new task's record past
          // DynamoDB's item: the prior task's own output record holds it.
          ...(outcome?.state === 'TASK_STATE_FAILED'
            ? { cause: withoutPayload(outcome.cause) }
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
      const message = params.message;
      if (message === undefined)
        throw new RequestMalformedError('the request carries no message');
      const sent: Message = {
        ...message,
        contextId,
        metadata: { ...message.metadata, [ADMISSION_METADATA_KEY]: admission },
      };
      // The whole envelope, so both records it is stored across stay bounded:
      // the input record, and the task record's metadata and tags.
      const envelopeBytes = Buffer.byteLength(JSON.stringify(envelope));
      if (envelopeBytes > TASK_INPUT_CAP_BYTES) {
        const rejected = finishedTask(
          newTask({
            id: randomUUIDv7(),
            contextId,
            state: 'TASK_STATE_SUBMITTED',
            metadata: taskMetadata(
              { ...envelope, metadata: undefined, tags: undefined },
              admission,
              config.image,
            ),
          }),
          {
            state: 'TASK_STATE_REJECTED',
            reason: `the start is ${envelopeBytes} bytes; the cap is ${TASK_INPUT_CAP_BYTES}. Pass a reference to large content, not the content. Its metadata and tags are not recorded`,
          },
        );
        await config.store.save(rejected);
        return rejected;
      }
      if (config.executor.stopping) {
        throw refusal(
          'CONTAINER_STOPPING',
          CONTAINER_STOPPING_RETRY_AFTER_SECONDS,
          CONTAINER_STOPPING_REASON,
        );
      }
      if (config.executor.liveCount >= config.admissionLimit) {
        throw refusal(
          'ADMISSION_LIMIT',
          ADMISSION_LIMIT_RETRY_AFTER_SECONDS,
          `the container is at its admission limit of ${config.admissionLimit} tasks`,
        );
      }
      const continuityRetryAfterSeconds =
        envelope.continuityKey === undefined
          ? undefined
          : config.executor.continuityKeyRetryAfterSeconds(
              envelope.continuityKey,
            );
      if (continuityRetryAfterSeconds !== undefined) {
        throw refusal(
          'CONTINUITY_KEY_RUNNING',
          continuityRetryAfterSeconds,
          `a task under continuity key "${envelope.continuityKey}" is running`,
        );
      }
      try {
        const started = await config.inner.sendMessage(
          {
            ...params,
            message: sent,
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
        if (!config.executor.takeStoppingRefusal(admission.startId)) {
          await config.store.bindKey(key, started.id, existingId);
          return started;
        }
      } catch (error) {
        // The task process may already run, and the caller, told the start
        // failed, holds nothing naming it: a retry would run beside it.
        await config.executor.stopFailedStart(admission.startId);
        throw error;
      }
      // Admitted as the container began to stop: the executor spawned nothing,
      // and the task it ended is bound to no key.
      throw refusal(
        'CONTAINER_STOPPING',
        CONTAINER_STOPPING_RETRY_AFTER_SECONDS,
        CONTAINER_STOPPING_REASON,
      );
    }

    /** Refuses the start in-band, logging it so an operator sees a container turning callers away. */
    function refusal(
      refused: StartRefusal,
      retryAfterSeconds: number,
      message: string,
    ): StartRefusalError {
      const error = new StartRefusalError(refused, retryAfterSeconds, message);
      console.warn(
        `start under idempotency key "${key}" refused, ${refused}: ${message}; retry after ${retryAfterSeconds}s`,
      );
      return error;
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

function withoutPayload(cause: Cause): Cause {
  const { payload: _payload, ...kept } = cause;
  return kept;
}
