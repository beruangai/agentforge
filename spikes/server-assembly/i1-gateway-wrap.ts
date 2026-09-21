/**
 * DESIGN_OPTIONS §I — how the A2A server is assembled. The local half.
 *
 * ARCHITECTURE.md §4 says idempotency, admission and the contract-hash check
 * must run BEFORE a task id is minted, which `DefaultRequestHandler` does not
 * allow: it mints the id and creates the event bus before the executor is
 * reached. The proposed shape is a gateway implementing the public
 * `A2ARequestHandler` interface and delegating to the SDK's once it has decided
 * a request is a new task.
 *
 * This asks whether that shape actually works, over a real HTTP server and a
 * real client:
 *
 *   1. The wrap compiles and serves — all twelve interface methods.
 *   2. A `submitted` event published SYNCHRONOUSLY by the executor makes
 *      `returnImmediately` resolve, rather than waiting for the run.
 *   3. An executor that does NOT publish synchronously — the negative control.
 *   4. The gateway can answer a duplicate idempotency key with the ALREADY
 *      RUNNING task, which is the thing an executor cannot do.
 *   5. A client built from a known card with an explicit endpoint, signing
 *      through `JsonRpcTransportFactory`'s `fetchImpl`, reaches the server with
 *      its headers intact.
 *   6. A client-supplied uuid7 `contextId` survives and returns on every task.
 *   7. `cancelTask` reaches the gateway rather than the SDK's default path.
 *   8. Admission refusal, and an unknown contract hash, are refusals the client
 *      can act on.
 *
 * No AWS. `fetchImpl` carries a stand-in for SigV4 here; the real signer is
 * exercised against AgentCore in the §B spike.
 *
 * Run: bun server-assembly/i1-gateway-wrap.ts
 */
import express from 'express';
import {
  AgentEvent,
  DefaultRequestHandler,
  InMemoryTaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { Role, TaskState } from '@a2a-js/sdk';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { v7 as uuid7 } from 'uuid';
import { finding, reportFindings } from '../harness.ts';

const PORT = 41777;
const ENDPOINT = `http://127.0.0.1:${PORT}/`;
const CONTRACT_HASH = 'sha256:deadbeef';
const ADMISSION_LIMIT = 2;

// ---------------------------------------------------------------------------
// The executor: publishes `submitted` synchronously, before its first await.
// ---------------------------------------------------------------------------

type ExecutorMode = 'synchronous-submit' | 'deferred-submit';

/** How long the "run" takes, so `returnImmediately` has something to beat. */
const RUN_MILLISECONDS = 3_000;

class SpikeExecutor implements AgentExecutor {
  public mode: ExecutorMode = 'synchronous-submit';
  public readonly cancelled = new Set<string>();
  public readonly started: string[] = [];

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    this.started.push(taskId);

    // FINDING: events are WRAPPED — `AgentEvent.task(task)`, not a task with a
    // `kind` field merged in — and `TaskState` is a numeric protobuf enum.
    const submitted = AgentEvent.task({
      id: taskId,
      contextId,
      status: {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date().toISOString(),
      },
      artifacts: [],
      history: [],
      metadata: { agentforgeContractHash: CONTRACT_HASH },
    });

    if (this.mode === 'synchronous-submit') {
      // The whole point: published before the first await.
      eventBus.publish(submitted);
    } else {
      // The negative control: the SDK is given nothing to resolve on.
      await new Promise((r) => setTimeout(r, RUN_MILLISECONDS));
      eventBus.publish(submitted);
    }

    await new Promise((r) => setTimeout(r, RUN_MILLISECONDS));
    if (this.cancelled.has(taskId)) {
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
          final: true,
          metadata: undefined,
        }),
      );
      eventBus.finished();
      return;
    }
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
        final: true,
        metadata: undefined,
      }),
    );
    eventBus.finished();
  }

  async cancelTask(taskId: string, _eventBus: ExecutionEventBus): Promise<void> {
    // The executor is the authority on cancellation; the gateway routes here.
    this.cancelled.add(taskId);
  }
}

// ---------------------------------------------------------------------------
// The gateway: the whole §I proposition.
// ---------------------------------------------------------------------------

type Envelope = {
  procedureName: string;
  contractHash: string;
  idempotencyKey: string;
};

class GatewayError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly reason: string,
  ) {
    super(message);
  }
}

/**
 * Implements the public `A2ARequestHandler` and delegates to the SDK's, but
 * decides admission, idempotency and the contract hash BEFORE delegating — so
 * before a task id exists.
 */
class Gateway {
  /** idempotency key -> task id, the index ADR 0009 calls for. */
  private readonly index = new Map<string, string>();
  private readonly live = new Set<string>();
  public readonly decisions: string[] = [];

  constructor(
    private readonly inner: DefaultRequestHandler,
    private readonly executor: SpikeExecutor,
  ) {}

  /**
   * FINDING: on the server side of `A2ARequestHandler`, `params.message` arrives
   * in a protobuf-normalized shape, NOT the wire/TypeScript `Message` shape a
   * client sends. A data part is `{ content: { $case: 'data', value } }`, not
   * `{ kind: 'data', data }`; `role` is a numeric enum; absent strings are `''`.
   * Both shapes are read here, because the same envelope reader must also work
   * against the type as declared.
   */
  private readEnvelope(params: any): Envelope {
    const parts = params?.message?.parts ?? params?.request?.parts ?? [];
    let data: any;
    for (const part of parts) {
      if (part?.content?.$case === 'data') data = part.content.value;
      else if (part?.kind === 'data') data = part.data;
      if (data) break;
    }
    if (!data?.idempotencyKey) {
      throw new GatewayError(
        `envelope missing: no data part carrying an idempotencyKey (saw ${JSON.stringify(parts).slice(0, 200)})`,
        -32602,
        'ENVELOPE_INVALID',
      );
    }
    return data as Envelope;
  }

  async sendMessage(params: any, context: any): Promise<any> {
    const envelope = this.readEnvelope(params);

    // 1. Contract hash — refuse before any work.
    if (envelope.contractHash !== CONTRACT_HASH) {
      this.decisions.push(`refused:hash:${envelope.idempotencyKey}`);
      throw new GatewayError(
        `this image does not implement ${envelope.contractHash}`,
        -32003,
        'UNKNOWN_CONTRACT_HASH',
      );
    }

    // 2. Idempotency — return the ALREADY RUNNING task. An executor cannot do
    //    this, because by the time it runs a new task id has been minted.
    const existing = this.index.get(envelope.idempotencyKey);
    if (existing) {
      this.decisions.push(`attached:${envelope.idempotencyKey}->${existing}`);
      return await this.inner.getTask({ tenant: '', id: existing } as any, context);
    }

    // 3. Admission — refused, never queued.
    if (this.live.size >= ADMISSION_LIMIT) {
      this.decisions.push(`refused:admission:${envelope.idempotencyKey}`);
      throw new GatewayError(
        `admission limit ${ADMISSION_LIMIT} reached`,
        -32004,
        'OVER_ADMISSION_LIMIT',
      );
    }

    // 4. Only now does a task id come into existence.
    this.decisions.push(`admitted:${envelope.idempotencyKey}`);
    const result = await this.inner.sendMessage(params, context);
    const taskId = (result as any).id;
    if (taskId) {
      this.index.set(envelope.idempotencyKey, taskId);
      this.live.add(taskId);
    }
    return result;
  }

  async cancelTask(params: any, context: any): Promise<any> {
    // A cancel NEVER falls through to the SDK's default path (ARCHITECTURE §4).
    const taskId = String(params?.id ?? '');
    this.decisions.push(`cancel:${taskId}`);
    await this.executor.cancelTask(taskId, undefined as any);
    return await this.inner.cancelTask(params, context);
  }

  release(taskId: string) {
    this.live.delete(taskId);
  }
}

/** All twelve methods: the gateway's own four, the rest delegated verbatim. */
function buildRequestHandler(inner: DefaultRequestHandler, gateway: Gateway): any {
  const delegated = [
    'getAgentCard',
    'getAuthenticatedExtendedAgentCard',
    'sendMessageStream',
    'getTask',
    'createTaskPushNotificationConfig',
    'getTaskPushNotificationConfig',
    'listTaskPushNotificationConfigs',
    'deleteTaskPushNotificationConfig',
    'resubscribe',
    'listTasks',
  ] as const;
  const handler: any = {
    sendMessage: (p: any, c: any) => gateway.sendMessage(p, c),
    cancelTask: (p: any, c: any) => gateway.cancelTask(p, c),
  };
  for (const method of delegated) {
    handler[method] = (...args: any[]) => (inner as any)[method](...args);
  }
  return handler;
}

// ---------------------------------------------------------------------------
// The card. Served from the image in production; a constant here.
// ---------------------------------------------------------------------------

const agentCard: any = {
  protocolVersion: '1.0',
  name: 'agentforge-spike',
  description: 'A2A server-assembly spike',
  version: '0.0.0',
  url: ENDPOINT,
  preferredTransport: 'JSONRPC',
  supportedInterfaces: [{ url: ENDPOINT, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' }],
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 'spike-procedure',
      name: 'spike-procedure',
      description: 'does nothing for three seconds',
      tags: ['spike'],
    },
  ],
};

// ---------------------------------------------------------------------------

const executor = new SpikeExecutor();
const taskStore = new InMemoryTaskStore();
const inner = new DefaultRequestHandler(agentCard, taskStore, executor);
const gateway = new Gateway(inner, executor);

const app = express();
app.use(express.json());
// Record what the server actually received, so the client's headers are proved
// to arrive rather than assumed to.
const seenHeaders: Record<string, string>[] = [];
app.use((req, _res, next) => {
  seenHeaders.push({ ...(req.headers as any) });
  next();
});
app.get('/.well-known/agent-card.json', (_req, res) => res.json(agentCard));
app.post('/', jsonRpcHandler({ requestHandler: buildRequestHandler(inner, gateway), userBuilder: UserBuilder.noAuthentication }));

const server = app.listen(PORT);
await new Promise((r) => server.once('listening', r as any));

// ---------------------------------------------------------------------------
// The client: explicit endpoint, known card, custom fetchImpl.
// ---------------------------------------------------------------------------

const signedRequests: string[] = [];

/** Stands in for SigV4: proves the client's fetch seam carries headers through. */
const signingFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('authorization', 'AWS4-HMAC-SHA256 Credential=SPIKE/20260922/us-west-2/bedrock-agentcore/aws4_request');
  headers.set('x-amzn-bedrock-agentcore-runtime-session-id', RUNTIME_SESSION_ID);
  signedRequests.push(String(input));
  return await fetch(input, { ...init, headers });
};

const RUNTIME_SESSION_ID = uuid7();

const factory = new ClientFactory(
  ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
    transports: [new JsonRpcTransportFactory({ fetchImpl: signingFetch })],
  }),
);
// createFromAgentCard, NOT createFromUrl: the card resolver cannot reach a card
// served through InvokeAgentRuntime, so a real client is built from a known card.
const client = await factory.createFromAgentCard(agentCard);

/**
 * FINDING: `Part` in 1.2.0 is the protobuf shape `{ content: { $case, value } }`,
 * and `Role` is a numeric enum. A part written the way the A2A specification
 * documents it — `{ kind: 'data', data }` — serializes to an EMPTY part with no
 * error at all: the server receives `{"filename":"","mediaType":""}`.
 */
function message(envelope: Envelope, contextId: string): any {
  return {
    message: {
      messageId: uuid7(),
      role: Role.ROLE_USER,
      contextId,
      taskId: '',
      parts: [
        {
          content: { $case: 'data' as const, value: envelope },
          metadata: undefined,
          filename: '',
          mediaType: 'application/json',
        },
      ],
      extensions: [],
      referenceTaskIds: [],
      metadata: undefined,
    },
    configuration: { returnImmediately: true, acceptedOutputModes: [] },
  };
}

const results: Record<string, unknown> = {};

// --- 1 & 2: synchronous submit makes returnImmediately resolve -------------
{
  executor.mode = 'synchronous-submit';
  const contextId = uuid7();
  const key = `key-${uuid7()}`;
  const started = Date.now();
  const task: any = await client.sendMessage(message({ procedureName: 'p', contractHash: CONTRACT_HASH, idempotencyKey: key }, contextId));
  const elapsed = Date.now() - started;
  const fast = elapsed < RUN_MILLISECONDS;
  finding(
    'I1 returnImmediately resolves on a synchronously published submitted event',
    fast && task?.status?.state === TaskState.TASK_STATE_SUBMITTED ? 'CONFIRMED' : 'FAILED',
    `resolved in ${elapsed}ms (the run takes ${RUN_MILLISECONDS * 2}ms)\n` +
      `state=${TaskState[task?.status?.state] ?? task?.status?.state} id=${task?.id}\n` +
      `client contextId echoed back = ${task?.contextId === contextId} (${task?.contextId})`,
  );
  results.synchronousSubmit = { elapsed, state: TaskState[task?.status?.state], contextEchoed: task?.contextId === contextId };

  // --- 4: a duplicate key returns the SAME, already-running task -----------
  const duplicate: any = await client.sendMessage(message({ procedureName: 'p', contractHash: CONTRACT_HASH, idempotencyKey: key }, contextId));
  finding(
    'I1 a duplicate idempotency key attaches to the running task',
    duplicate?.id === task?.id ? 'CONFIRMED' : 'FAILED',
    `first=${task?.id}\nsecond=${duplicate?.id}\nexecutor started ${executor.started.length} task(s) — a second start would mean the gateway decided too late\n` +
      `gateway decisions: ${gateway.decisions.join(' | ')}`,
  );
  results.idempotency = { same: duplicate?.id === task?.id, executorStarts: executor.started.length };

  // --- 6: contextId survives on a poll too --------------------------------
  const polled: any = await client.getTask({ tenant: '', id: task.id } as any);
  finding(
    'I1 a client-supplied uuid7 contextId returns on every task',
    polled?.contextId === contextId ? 'CONFIRMED' : 'FAILED',
    `supplied=${contextId}\nonSend=${task?.contextId}\nonGetTask=${polled?.contextId}\n` +
      `uuid7 preserved verbatim = ${polled?.contextId === contextId}`,
  );
  results.contextId = { supplied: contextId, returned: polled?.contextId };

  // --- 7: cancel reaches the gateway --------------------------------------
  const cancelled: any = await client.cancelTask({ tenant: '', id: task.id, metadata: undefined } as any).catch((e: any) => ({ error: String(e) }));
  finding(
    'I1 cancelTask reaches the gateway, not the SDK default path',
    gateway.decisions.some((d) => d.startsWith('cancel:')) && executor.cancelled.has(task.id) ? 'CONFIRMED' : 'FAILED',
    `gateway saw the cancel = ${gateway.decisions.some((d) => d.startsWith('cancel:'))}\n` +
      `executor.cancelTask was called = ${executor.cancelled.has(task.id)}\n` +
      `resulting state = ${TaskState[cancelled?.status?.state] ?? cancelled?.error}`,
  );
  results.cancel = { reachedExecutor: executor.cancelled.has(task.id), state: TaskState[cancelled?.status?.state] };
  gateway.release(task.id);
}

// --- 3: the negative control ----------------------------------------------
{
  executor.mode = 'deferred-submit';
  const started = Date.now();
  const task: any = await client
    .sendMessage(message({ procedureName: 'p', contractHash: CONTRACT_HASH, idempotencyKey: `key-${uuid7()}` }, uuid7()))
    .catch((e: any) => ({ error: String(e) }));
  const elapsed = Date.now() - started;
  finding(
    'I1 NEGATIVE CONTROL: without a synchronous submit, returnImmediately waits',
    elapsed >= RUN_MILLISECONDS ? 'CONFIRMED' : 'UNEXPECTED',
    `resolved in ${elapsed}ms — the executor deferred its first event by ${RUN_MILLISECONDS}ms\n` +
      `state=${TaskState[task?.status?.state] ?? task?.error}\n` +
      `So the synchronous publish is load-bearing, not incidental: the executor MUST publish before its first await.`,
  );
  results.deferredSubmit = { elapsed };
  executor.mode = 'synchronous-submit';
  if (task?.id) gateway.release(task.id);
}

// --- 8a: unknown contract hash is a refusal the client can act on ----------
{
  const outcome = await client
    .sendMessage(message({ procedureName: 'p', contractHash: 'sha256:not-this-image', idempotencyKey: `key-${uuid7()}` }, uuid7()))
    .then((t: any) => ({ ok: true, t }))
    .catch((e: any) => ({ ok: false, error: e }));
  const error: any = (outcome as any).error;
  finding(
    'I1 an unknown contract hash surfaces as an actionable client error',
    !(outcome as any).ok ? 'CONFIRMED' : 'FAILED',
    `threw = ${!(outcome as any).ok}\n` +
      `name=${error?.name} code=${error?.code ?? error?.error?.code}\n` +
      `message=${String(error?.message ?? '').slice(0, 200)}`,
  );
  results.unknownHash = { threw: !(outcome as any).ok, code: error?.code, message: String(error?.message ?? '').slice(0, 200) };
}

// --- 8b: admission refusal -------------------------------------------------
{
  const keys = [uuid7(), uuid7(), uuid7()].map((k) => `key-${k}`);
  const outcomes = [];
  for (const key of keys) {
    outcomes.push(
      await client
        .sendMessage(message({ procedureName: 'p', contractHash: CONTRACT_HASH, idempotencyKey: key }, uuid7()))
        .then((t: any) => `admitted:${t.id}`)
        .catch((e: any) => `refused:${e?.message ?? e}`.slice(0, 120)),
    );
  }
  const refusals = outcomes.filter((o) => o.startsWith('refused')).length;
  finding(
    'I1 admission beyond the limit is refused, never queued',
    refusals >= 1 ? 'CONFIRMED' : 'FAILED',
    `limit=${ADMISSION_LIMIT}, three sent\n${outcomes.map((o, i) => `  ${i + 1}. ${o}`).join('\n')}`,
  );
  results.admission = { outcomes };
}

// --- 5: the signing seam ---------------------------------------------------
{
  const sawAuthorization = seenHeaders.some((h) => String(h.authorization ?? '').startsWith('AWS4-HMAC-SHA256'));
  const sawSession = seenHeaders.some(
    (h) => h['x-amzn-bedrock-agentcore-runtime-session-id'] === RUNTIME_SESSION_ID,
  );
  finding(
    "I1 a client with an explicit endpoint signs through JsonRpcTransport's fetchImpl",
    sawAuthorization && sawSession ? 'CONFIRMED' : 'FAILED',
    `fetchImpl invoked ${signedRequests.length} time(s), all to ${[...new Set(signedRequests)].join(', ')}\n` +
      `server saw an AWS4-HMAC-SHA256 authorization header = ${sawAuthorization}\n` +
      `server saw the runtime session header verbatim = ${sawSession}\n` +
      `card fetched over HTTP by the client = ${signedRequests.some((u) => u.includes('.well-known'))} (must be false: built from a known card)`,
  );
  results.signing = { calls: signedRequests.length, sawAuthorization, sawSession };
}

reportFindings();
server.close();
await Bun.write(`${import.meta.dir}/../out/i1-summary.json`, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
process.exit(0);
