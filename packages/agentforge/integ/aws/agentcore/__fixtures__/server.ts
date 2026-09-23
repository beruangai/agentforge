/**
 * The container the AgentCore integration tests run: an A2A server on
 * AgentCore's contract, carrying the §I gateway and instrumented for §A, §B,
 * §C and §I's pass-through questions. It is the thing AgentCore's behaviour is
 * observed through — NOT AgentForge's server, which is built in A1. No model
 * is called — a "task" is a timer — so the tests are deterministic and cost
 * nothing but compute.
 *
 * Bundled with `bun build --target=bun` and run on Bun inside the image.
 *
 * AgentCore's contract (docs/research/agentcore-runtime.md):
 *   0.0.0.0:9000, JSON-RPC on POST /, card at /.well-known/agent-card.json,
 *   GET /ping returning {"status": "Healthy" | "HealthyBusy"}.
 *
 * What it records, so the tests can assert rather than infer:
 *   - a CONTAINER ID minted once at process start, returned on every task, so a
 *     second container serving one runtime session id is detectable (§B)
 *   - every request's header names, to stdout, so `A2A-Version`, custom
 *     headers and `content-type` can be checked for pass-through through
 *     `InvokeAgentRuntime` (§I)
 *   - live task count, driving /ping (§B)
 *   - SIGTERM receipt and a heartbeat after it, for `StopRuntimeSession` (§C)
 */
import { randomUUIDv7 } from 'node:crypto';
import {
  type AgentCard,
  type Message,
  type Part,
  type SendMessageRequest,
  type Task,
  TaskState,
} from '@a2a-js/sdk';
import {
  type A2ARequestHandler,
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  type RequestContext,
  type ServerCallContext,
} from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from '@aws-sdk/client-dynamodb';
import express from 'express';
import { buildFixtureAgentCard } from '../../../__fixtures__/agent-card.ts';
import type { ContainerLogEvent } from './container-log-events.ts';
import {
  type FixtureEnvelope,
  type FixtureTaskMetadata,
  fixtureEnvelopeSchema,
  type LeaseRequest,
} from './envelope.ts';

const port = Number(process.env.A2A_PORT ?? 9000);
/** A container names itself: a uuid7 at start (ARCHITECTURE.md §4). */
const containerId = randomUUIDv7();
const startedAt = Date.now();

/** Live tasks. `/ping` reports HealthyBusy while any is running (§B). */
const liveTaskIds = new Set<string>();
/** Where to record an outcome if SIGTERM arrives (§C). Set by a task. */
let outcomeTarget: { tableName: string; leaseId: string } | undefined;
let sigtermAt: number | undefined;

function log(event: ContainerLogEvent): void {
  console.log(JSON.stringify(event));
}

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 300) }
    : { name: 'NonError', message: String(error).slice(0, 300) };
}

const dynamo = new DynamoDBClient({});

type LeaseMeasurement = {
  writeLatencyMilliseconds: number;
  visibleAfterMilliseconds: number | null;
  readBackPolls: number;
};

/**
 * §A — writes a lease generation, then reads it back FROM INSIDE the microVM
 * until the new generation appears.
 *
 * Measuring visibility from outside AWS conflates four things — the write,
 * DynamoDB's own propagation, the reader's network RTT, and the skew between
 * two unsynchronised clocks. A first attempt from a laptop reported ~322 ms
 * with a 239 ms read RTT and a 333 ms apparent clock offset, which is not a
 * platform figure. Polling here uses ONE clock and one network.
 */
async function writeLease(
  lease: LeaseRequest,
  generation: number,
  taskId: string,
): Promise<LeaseMeasurement> {
  const writeIssuedAt = Date.now();
  await dynamo.send(
    new PutItemCommand({
      TableName: lease.tableName,
      Item: {
        leaseId: { S: lease.leaseId },
        generation: { N: String(generation) },
        containerId: { S: containerId },
        taskId: { S: taskId },
        // The only honest timestamp available: the item is composed before the
        // write completes, so it cannot carry its own completion time.
        writeIssuedAt: { N: String(writeIssuedAt) },
      },
    }),
  );
  const writeLatencyMilliseconds = Date.now() - writeIssuedAt;

  let readBackPolls = 0;
  let visibleAfterMilliseconds: number | null = null;
  while (Date.now() - writeIssuedAt <= 10_000) {
    readBackPolls += 1;
    const read = await dynamo.send(
      new GetItemCommand({
        TableName: lease.tableName,
        Key: { leaseId: { S: lease.leaseId } },
      }),
    );
    if (Number(read.Item?.generation?.N ?? 0) >= generation) {
      visibleAfterMilliseconds = Date.now() - writeIssuedAt;
      break;
    }
  }

  log({
    event: 'lease',
    containerId,
    leaseId: lease.leaseId,
    taskId,
    generation,
    writeLatencyMilliseconds,
    visibleAfterMilliseconds,
    readBackPolls,
    writeIssuedAt,
  });
  return { writeLatencyMilliseconds, visibleAfterMilliseconds, readBackPolls };
}

/**
 * FINDING (§I, 2026-09-22): under the 1.0 RPC method name `SendMessage`, a part
 * whose content the parser does not recognise is accepted and its content
 * dropped — `filename` and `mediaType` survive, `content` does not, and nothing
 * errors. An executor reading the envelope trustingly falls through to its
 * defaults. So this refuses a part it cannot decode rather than returning {}.
 *
 * Inside the server, parts arrive protobuf-normalised whatever was on the
 * wire: a data part is `{ content: { $case: 'data', value } }`.
 */
function readEnvelope(message: Message | undefined): FixtureEnvelope {
  if (message === undefined) throw new Error('the request carries no message');
  if (message.parts.length === 0) throw new Error('the message has no parts');
  const dataParts = message.parts.filter(
    (part: Part) => part.content?.$case === 'data',
  );
  const [dataPart] = dataParts;
  if (dataParts.length !== 1 || dataPart?.content?.$case !== 'data') {
    throw new Error(
      `expected exactly one decodable data part, got ${dataParts.length} of ${message.parts.length} — ` +
        `keys ${message.parts.map((part) => Object.keys(part).join('+')).join(' | ')}. ` +
        'A part the parser did not recognise is delivered with its content stripped.',
    );
  }
  return fixtureEnvelopeSchema.parse(dataPart.content.value);
}

class TimerExecutor implements AgentExecutor {
  readonly #cancelled = new Set<string>();

  requestCancellation(taskId: string): void {
    this.#cancelled.add(taskId);
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId } = requestContext;
    const envelope = readEnvelope(requestContext.request.message);

    liveTaskIds.add(taskId);
    if (envelope.lease !== undefined) {
      outcomeTarget = {
        tableName: envelope.lease.tableName,
        leaseId: envelope.lease.leaseId,
      };
    }

    const metadata: FixtureTaskMetadata = {
      containerId,
      containerUptimeMilliseconds: Date.now() - startedAt,
      liveTasks: liveTaskIds.size,
      idempotencyKey: envelope.idempotencyKey ?? null,
      runMilliseconds: envelope.runMilliseconds,
      negotiatedVersion: requestContext.context.requestedVersion,
      containerNow: Date.now(),
    };
    // Published BEFORE the first await, so `returnImmediately` resolves on it.
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: {
          state: TaskState.TASK_STATE_SUBMITTED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [],
        metadata,
      }),
    );

    const deadline = Date.now() + envelope.runMilliseconds;
    let generation = 0;
    let nextRenewalAt = Date.now();
    let leaseFailure: { name: string; message: string } | undefined;
    while (Date.now() < deadline && !this.#cancelled.has(taskId)) {
      const lease = envelope.lease;
      if (
        lease !== undefined &&
        generation < lease.renewals &&
        Date.now() >= nextRenewalAt
      ) {
        generation += 1;
        nextRenewalAt = Date.now() + lease.renewMilliseconds;
        try {
          await writeLease(lease, generation, taskId);
        } catch (error) {
          // Zero silent failures: a lease that cannot be written fails the task.
          leaseFailure = describeError(error);
          log({
            event: 'lease-failed',
            containerId,
            leaseId: lease.leaseId,
            generation,
            errorName: leaseFailure.name,
            errorMessage: leaseFailure.message,
          });
          break;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const cancelled = this.#cancelled.has(taskId);
    liveTaskIds.delete(taskId);
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: cancelled
            ? TaskState.TASK_STATE_CANCELED
            : leaseFailure !== undefined
              ? TaskState.TASK_STATE_FAILED
              : TaskState.TASK_STATE_COMPLETED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        metadata: undefined,
      }),
    );
    eventBus.finished();
  }

  async cancelTask(taskId: string): Promise<void> {
    this.requestCancellation(taskId);
  }
}

const url = process.env.AGENTCORE_RUNTIME_URL ?? `http://0.0.0.0:${port}/`;
/**
 * §I — refuse 0.3 entirely. With A2A_STRICT_10 the card declares ONE
 * interface, 1.0, and `legacyCompat` is off (ADR 0014). With `legacyCompat`
 * ON, a missing `A2A-Version` allowlist entry downgrades every call to 0.3 and
 * everything appears to work on the wrong protocol; OFF, the same mistake
 * fails loudly.
 */
const strict10 = process.env.A2A_STRICT_10 === '1';
const agentCard = buildFixtureAgentCard({ url, strict10 });

const executor = new TimerExecutor();
const inner = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  executor,
);

/**
 * The §I gateway: idempotency decided before a task id is minted. The A2A SDK
 * mints the task id before the executor is reached, so an executor cannot
 * answer with an already-running task — that has to sit in front of the
 * handler.
 */
const taskIdByIdempotencyKey = new Map<string, string>();

async function sendMessageOnce(
  params: SendMessageRequest,
  context: ServerCallContext,
): Promise<Message | Task> {
  const { idempotencyKey } = readEnvelope(params.message);
  const existingTaskId =
    idempotencyKey === undefined
      ? undefined
      : taskIdByIdempotencyKey.get(idempotencyKey);
  if (existingTaskId !== undefined) {
    return await inner.getTask({ tenant: '', id: existingTaskId }, context);
  }
  const result = await inner.sendMessage(params, context);
  if (idempotencyKey !== undefined && 'status' in result) {
    taskIdByIdempotencyKey.set(idempotencyKey, result.id);
  }
  return result;
}

/**
 * A cancel reaches the executor, never only the SDK's default path, which
 * marks a task cancelled without consulting it.
 */
const cancelTaskThroughExecutor: A2ARequestHandler['cancelTask'] = async (
  params,
  context,
) => {
  executor.requestCancellation(params.id);
  return await inner.cancelTask(params, context);
};

const gateway: A2ARequestHandler = new Proxy(inner, {
  get(target, property, receiver) {
    if (property === 'sendMessage') return sendMessageOnce;
    if (property === 'cancelTask') return cancelTaskThroughExecutor;
    const value: unknown = Reflect.get(target, property, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

function headerValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(',') : value;
}

const app = express();
// FINDING: `express.json()` only parses when the content-type matches, and a
// request arriving through `InvokeAgentRuntime` carries whatever content type
// the caller sent — none at all from the AWS CLI. Parsing regardless of
// content-type makes the body parse; it does NOT stop the A2A handler
// refusing a content type it does not accept.
app.use(express.json({ limit: '10mb', type: () => true }));
app.use((request, _response, next) => {
  // To stdout, so the headers reach CloudWatch and the pass-through questions
  // (§I) are answerable without reaching into the container.
  if (request.path !== '/ping') {
    const body: unknown = request.body;
    const jsonRpcMethod =
      typeof body === 'object' &&
      body !== null &&
      'method' in body &&
      typeof body.method === 'string'
        ? body.method
        : null;
    log({
      event: 'request',
      containerId,
      method: request.method,
      path: request.path,
      contentType: headerValue(request.headers['content-type']),
      a2aVersion: headerValue(request.headers['a2a-version']),
      runtimeSessionId: headerValue(
        request.headers['x-amzn-bedrock-agentcore-runtime-session-id'],
      ),
      headerNames: Object.keys(request.headers),
      jsonRpcMethod,
    });
  }
  next();
});

// AgentCore's health contract: a lifecycle signal, not admission control.
app.get('/ping', (_request, response) => {
  response.json({ status: liveTaskIds.size > 0 ? 'HealthyBusy' : 'Healthy' });
});

app.get('/.well-known/agent-card.json', (_request, response) => {
  const card: AgentCard = agentCard;
  response.json(card);
});

app.use(
  jsonRpcHandler({
    requestHandler: gateway,
    // AgentCore terminates SigV4 in front of the container; inside, requests
    // are trusted. The microVM boundary is the trust boundary.
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat: { enabled: !strict10 },
  }),
);

process.on('SIGTERM', () => {
  const receivedAt = Date.now();
  sigtermAt = receivedAt;
  log({
    event: 'sigterm',
    containerId,
    at: receivedAt,
    liveTasks: liveTaskIds.size,
  });
  // §C — is the grace period USABLE? Knowing a container has ~60 seconds is
  // only half the answer; what matters is whether it can still reach the
  // network and record an outcome in them. So the first thing the handler
  // does is write one, and time it.
  if (outcomeTarget !== undefined) {
    const writeStartedAt = Date.now();
    dynamo
      .send(
        new PutItemCommand({
          TableName: outcomeTarget.tableName,
          Item: {
            leaseId: { S: `${outcomeTarget.leaseId}#outcome` },
            containerId: { S: containerId },
            recordedAfterSigtermMilliseconds: {
              N: String(writeStartedAt - receivedAt),
            },
            liveTasksAtSigterm: { N: String(liveTaskIds.size) },
            outcome: { S: 'RECORDED_DURING_SHUTDOWN' },
          },
        }),
      )
      .then(
        () =>
          log({
            event: 'shutdown-outcome',
            containerId,
            written: true,
            tookMilliseconds: Date.now() - writeStartedAt,
            afterSigtermMilliseconds: writeStartedAt - receivedAt,
            errorName: null,
            errorMessage: null,
          }),
        (error: unknown) => {
          const described = describeError(error);
          log({
            event: 'shutdown-outcome',
            containerId,
            written: false,
            tookMilliseconds: Date.now() - writeStartedAt,
            afterSigtermMilliseconds: writeStartedAt - receivedAt,
            errorName: described.name,
            errorMessage: described.message,
          });
        },
      );
  }

  // Deliberately does NOT exit. The grace period between SIGTERM and the kill
  // bounds what a cancelled run can finish, and therefore whether side-effect
  // recovery is possible at all. A heartbeat makes it measurable: the last one
  // logged is the moment the process died. It stops at 180 seconds, so a
  // container the platform never kills shows as a heartbeat that ran out.
  const beat = setInterval(() => {
    const millisecondsSinceSigterm = Date.now() - (sigtermAt ?? receivedAt);
    log({
      event: 'post-sigterm',
      containerId,
      millisecondsSinceSigterm,
      liveTasks: liveTaskIds.size,
    });
    if (millisecondsSinceSigterm > 180_000) clearInterval(beat);
  }, 500);
});

app.listen(port, '0.0.0.0', (error) => {
  // Express 5 hands a failed listen to the callback; on Bun an absent error
  // arrives as null, not undefined.
  if (error) throw error;
  log({
    event: 'listening',
    containerId,
    port,
    strict10,
    at: Date.now(),
  });
});
