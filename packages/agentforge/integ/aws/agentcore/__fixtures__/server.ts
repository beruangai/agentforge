/**
 * The container the AgentCore integration tests run: an A2A server on
 * AgentCore's contract, instrumented for what `docs/research/agentcore-runtime-observed.md`
 * answers (its §B and §C) and ADR 0014. It is the thing AgentCore's behaviour is
 * observed through — NOT AgentForge's server, which `agentforge-runtime.test.ts` deploys. No model is called — a "task" is a timer — so the tests are
 * deterministic and cost nothing but compute.
 *
 * Bundled with `bun build --target=bun` and run on Bun inside the image.
 *
 * AgentCore's contract (docs/research/agentcore-runtime.md):
 *   0.0.0.0:9000, JSON-RPC on POST /, card at /.well-known/agent-card.json,
 *   GET /ping returning {"status": "Healthy" | "HealthyBusy"}.
 *
 * What it records, so the tests can assert rather than infer:
 *   - a CONTAINER ID, returned on every task, so which container answered is
 *     observed (research §B, research §C)
 *   - every invocation's `A2A-Version`, session id and JSON-RPC method, to
 *     stdout, so what reached the container is observed (ADR 0014)
 *   - live task count, driving /ping (research §B)
 *   - SIGTERM receipt and a heartbeat after it, for `StopRuntimeSession` (research §C),
 *     and an outcome written from the SIGTERM handler
 *
 * Nothing that must differ per container is taken at startup. On platform
 * version V2 every container is restored from one snapshot taken at the first
 * healthy `/ping`, so a value minted at process start is the same in every
 * container (docs/research/agentcore-runtime.md §Platform version V2).
 */
import { randomUUIDv7 } from 'node:crypto';
import {
  type AgentCard,
  type Message,
  type Part,
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
} from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import express from 'express';
import { buildFixtureAgentCard } from '../../../__fixtures__/agent-card.ts';
import type { ContainerLogEvent } from './container-log-events.ts';
import {
  type FixtureEnvelope,
  FixtureEnvelopeSchema,
  type FixtureTaskMetadata,
  type OutcomeTarget,
} from './envelope.ts';

const port = Number(process.env.A2A_PORT ?? 9000);

let mintedContainerId: string | undefined;
/**
 * A container names itself with a uuid7 (ARCHITECTURE.md §4) — minted on first
 * use, never at startup. Its first use is an invocation or a SIGTERM, both
 * after a V2 restore; `/ping` and the agent card, which AgentCore may call
 * before the snapshot, never reach it.
 */
function containerId(): string {
  mintedContainerId ??= randomUUIDv7();
  return mintedContainerId;
}

/** Live tasks. `/ping` reports HealthyBusy while any is running (research §B). */
const liveTaskIds = new Set<string>();
/** Where to record an outcome if SIGTERM arrives (research §C). Set by a task. */
let outcomeTarget: OutcomeTarget | undefined;
let sigtermAt: number | undefined;

function log(event: ContainerLogEvent): void {
  console.log(JSON.stringify(event));
}

function describeError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message.slice(0, 300) }
    : { name: 'NonError', message: String(error).slice(0, 300) };
}

/**
 * Built at startup but first used after a restore, so its credentials and
 * connections are resolved in the restored container.
 */
const dynamoDB = new DynamoDBClient({});

/**
 * FINDING (ADR 0014, 2026-09-22): under the 1.0 RPC method name `SendMessage`, a part
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
  return FixtureEnvelopeSchema.parse(dataPart.content.value);
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
    if (envelope.outcomeTarget !== undefined) {
      outcomeTarget = envelope.outcomeTarget;
    }

    const metadata: FixtureTaskMetadata = {
      containerId: containerId(),
      liveTasks: liveTaskIds.size,
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
    while (Date.now() < deadline && !this.#cancelled.has(taskId)) {
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
 * ADR 0014 — refuse 0.3 entirely. With A2A_ONE_ZERO_ONLY the card declares ONE
 * interface, 1.0, and `legacyCompat` is off (ADR 0014). With `legacyCompat`
 * ON, a missing `A2A-Version` allowlist entry downgrades every call to 0.3 and
 * everything appears to work on the wrong protocol; OFF, the same mistake
 * fails loudly.
 */
const a2aOneZeroOnly = process.env.A2A_ONE_ZERO_ONLY === '1';
const agentCard = buildFixtureAgentCard({ url, a2aOneZeroOnly });

const executor = new TimerExecutor();
const inner = new DefaultRequestHandler(
  agentCard,
  new InMemoryTaskStore(),
  executor,
);

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
  // To stdout, so what reached the container reaches CloudWatch and ADR 0014 is
  // answerable without reaching into the container. Invocations only: the
  // container id is minted on first use, after a V2 restore.
  if (request.method === 'POST') {
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
      containerId: containerId(),
      a2aVersion: headerValue(request.headers['a2a-version']),
      runtimeSessionId: headerValue(
        request.headers['x-amzn-bedrock-agentcore-runtime-session-id'],
      ),
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
    legacyCompat: { enabled: !a2aOneZeroOnly },
  }),
);

process.on('SIGTERM', () => {
  const receivedAt = Date.now();
  sigtermAt = receivedAt;
  log({
    event: 'sigterm',
    containerId: containerId(),
    at: receivedAt,
    liveTasks: liveTaskIds.size,
  });
  // research §C — is the grace period USABLE? Knowing how long a container has is only
  // half the answer; what matters is whether it can still reach the
  // network and record an outcome in them. So the first thing the handler
  // does is write one, and time it.
  if (outcomeTarget !== undefined) {
    const writeStartedAt = Date.now();
    dynamoDB
      .send(
        new PutItemCommand({
          TableName: outcomeTarget.tableName,
          Item: {
            outcomeKey: { S: outcomeTarget.key },
            containerId: { S: containerId() },
            liveTasksAtSigterm: { N: String(liveTaskIds.size) },
            outcome: { S: 'RECORDED_DURING_SHUTDOWN' },
          },
        }),
      )
      .then(
        () =>
          log({
            event: 'shutdown-outcome',
            containerId: containerId(),
            written: true,
            tookMilliseconds: Date.now() - writeStartedAt,
            errorName: null,
            errorMessage: null,
          }),
        (error: unknown) => {
          const described = describeError(error);
          log({
            event: 'shutdown-outcome',
            containerId: containerId(),
            written: false,
            tookMilliseconds: Date.now() - writeStartedAt,
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
      containerId: containerId(),
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
});
