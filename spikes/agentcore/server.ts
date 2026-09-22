/**
 * The container the AgentCore spikes run: an A2A server on AgentCore's contract,
 * carrying the §I gateway and instrumented for §B, §C and §I's pass-through
 * questions. No model is called — a "task" is a timer — so the spikes are
 * deterministic and cost nothing but compute.
 *
 * AgentCore's contract (research/agentcore-runtime.md):
 *   0.0.0.0:9000, JSON-RPC on POST /, card at /.well-known/agent-card.json,
 *   GET /ping returning {"status": "Healthy" | "HealthyBusy"}.
 *
 * What it records, so the spikes can assert rather than infer:
 *   - a CONTAINER ID minted once at process start, returned on every task, so a
 *     second container serving one runtime session id is detectable (§B)
 *   - every request header, so `A2A-Version` and the session header can be
 *     checked for pass-through through InvokeAgentRuntime (§I)
 *   - live task count, driving /ping (§B, D31)
 *   - SIGTERM receipt and its timestamp, for StopRuntimeSession (§C)
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
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { TaskState } from '@a2a-js/sdk';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.A2A_PORT ?? 9000);
const CONTAINER_ID = randomUUID();
const STARTED_AT = Date.now();

/** Live tasks. `/ping` reports HealthyBusy while any is running (§B). */
const live = new Set<string>();
/** Every request's headers, for the pass-through questions (§I). */
const seen: { at: number; path: string; headers: Record<string, unknown> }[] = [];
let sigtermAt: number | undefined;

type Envelope = {
  procedureName?: string;
  idempotencyKey?: string;
  /** How long the "task" should take. A timer, never a model call. */
  runMilliseconds?: number;
};

/**
 * FINDING (§I, 2026-09-22): a part whose encoding does not match the NEGOTIATED
 * protocol version is stripped of its content and delivered anyway — `filename`
 * and `mediaType` survive, `content` does not, and nothing errors. AgentCore
 * forwards no `A2A-Version` header, so the negotiated version is always 0.3 and
 * a client sending the 1.0 protobuf part shape loses its whole payload in
 * silence. So this refuses a part it cannot decode rather than returning {}.
 */
function readEnvelope(source: any): Envelope {
  // The executor is handed a RequestContext; the gateway is handed raw params.
  const parts =
    source?.request?.message?.parts ??
    source?.message?.parts ??
    source?.request?.parts ??
    source?.parts;
  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error(`no parts in ${Object.keys(source ?? {}).join(',')}`);
  }
  for (const part of parts) {
    if (part?.content?.$case === 'data') return part.content.value ?? {};
    if (part?.kind === 'data') return part.data ?? {};
    if (part?.data && typeof part.data === 'object') return part.data;
  }
  throw new Error(
    `a part carries no decodable content — keys ${parts.map((p: any) => Object.keys(p ?? {}).join('+')).join(' | ')}. ` +
      'A 1.0-shaped part sent to a 0.3-negotiated server is stripped in transit.',
  );
}

class SpikeExecutor implements AgentExecutor {
  readonly cancelled = new Set<string>();

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = requestContext;
    // Dump the RequestContext shape once, so readEnvelope is written against
    // what the SDK actually hands the executor rather than against the wire.
    console.log(JSON.stringify({ event: 'requestContext', keys: Object.keys(requestContext as any),
      dump: JSON.parse(JSON.stringify(requestContext, (_k, v) => (typeof v === 'bigint' ? String(v) : v))) }));
    const envelope = readEnvelope(requestContext as any);
    const duration = Number(envelope.runMilliseconds ?? 1_000);

    live.add(taskId);

    // Published BEFORE the first await, so returnImmediately resolves on it.
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [],
        metadata: {
          containerId: CONTAINER_ID,
          containerUptimeMs: Date.now() - STARTED_AT,
          liveTasks: live.size,
          idempotencyKey: envelope.idempotencyKey ?? null,
          runMilliseconds: duration,
          // The version the SDK negotiated for this request. Behind AgentCore
          // this is always 0.3, because no A2A-Version header is forwarded (§I).
          negotiatedVersion: (requestContext as any).context?._requestedVersion ?? null,
        },
      }),
    );

    const deadline = Date.now() + duration;
    while (Date.now() < deadline && !this.cancelled.has(taskId)) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const cancelled = this.cancelled.has(taskId);
    live.delete(taskId);
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId,
        status: {
          state: cancelled ? TaskState.TASK_STATE_CANCELED : TaskState.TASK_STATE_COMPLETED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        final: true,
        metadata: { containerId: CONTAINER_ID, cancelled },
      }),
    );
    eventBus.finished();
  }

  async cancelTask(taskId: string): Promise<void> {
    this.cancelled.add(taskId);
  }
}

const url = process.env.AGENTCORE_RUNTIME_URL ?? `http://0.0.0.0:${PORT}/`;
const agentCard: any = {
  protocolVersion: '1.0',
  name: 'agentforge-spike',
  description: 'AgentCore reachability and concurrency spike',
  version: '0.0.0',
  url,
  preferredTransport: 'JSONRPC',
  // Both versions declared: AgentCore's documented card shape speaks 0.3, and
  // an absent A2A-Version header is treated as 0.3 by the SDK (§I).
  supportedInterfaces: [
    { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
    { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' },
  ],
  capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [{ id: 'spike', name: 'spike', description: 'sleeps for a requested duration', tags: ['spike'] }],
};

const executor = new SpikeExecutor();
const inner = new DefaultRequestHandler(agentCard, new InMemoryTaskStore(), executor);

/** The §I gateway: idempotency decided before a task id is minted. */
const index = new Map<string, string>();
const handler: any = new Proxy(inner, {
  get(target: any, property) {
    if (property === 'sendMessage') {
      return async (params: any, context: any) => {
        const envelope = readEnvelope(params);
        const key = envelope.idempotencyKey;
        if (key && index.has(key)) {
          return await target.getTask({ tenant: '', id: index.get(key) }, context);
        }
        const result = await target.sendMessage(params, context);
        if (key && result?.id) index.set(key, result.id);
        return result;
      };
    }
    if (property === 'cancelTask') {
      return async (params: any, context: any) => {
        await executor.cancelTask(String(params?.id ?? ''));
        return await target.cancelTask(params, context);
      };
    }
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

const app = express();
// FINDING: `express.json()` only parses when the content-type matches, and a
// request arriving through `InvokeAgentRuntime` may not carry one the default
// matcher accepts — which surfaces as the A2A SDK's "Invalid request body
// type." Parsing regardless of content-type is what a proxied request needs.
app.use(express.json({ limit: '10mb', type: () => true }));
app.use((request, _response, next) => {
  seen.push({ at: Date.now(), path: request.path, headers: { ...request.headers } });
  // To stdout as well, so the headers reach CloudWatch and the pass-through
  // questions (§I) are answerable without reaching into the container.
  if (request.path !== '/ping') {
    console.log(
      JSON.stringify({
        event: 'request',
        containerId: CONTAINER_ID,
        method: request.method,
        path: request.path,
        contentType: request.headers['content-type'] ?? null,
        a2aVersion: request.headers['a2a-version'] ?? null,
        sessionHeader:
          request.headers['x-amzn-bedrock-agentcore-runtime-session-id'] ??
          request.headers['x-amzn-bedrock-agentcore-runtime-session-id'.toLowerCase()] ??
          null,
        headerNames: Object.keys(request.headers),
        bodyType: typeof request.body,
        bodyKeys: request.body && typeof request.body === 'object' ? Object.keys(request.body) : null,
        jsonrpcMethod: (request.body as any)?.method ?? null,
      }),
    );
  }
  next();
});

// AgentCore's health contract. On its own event loop concern: nothing a task
// does can stall this, because a task is never on this path (D31).
app.get('/ping', (_request, response) => {
  response.json({ status: live.size > 0 ? 'HealthyBusy' : 'Healthy' });
});

// Everything the spikes need to assert, without shelling into the container.
app.get('/spike/state', (_request, response) => {
  response.json({
    containerId: CONTAINER_ID,
    startedAt: STARTED_AT,
    uptimeMs: Date.now() - STARTED_AT,
    liveTasks: [...live],
    idempotencyIndexSize: index.size,
    sigtermAt: sigtermAt ?? null,
    requests: seen.slice(-50),
  });
});

app.get('/.well-known/agent-card.json', (_request, response) => response.json(agentCard));

app.use(
  jsonRpcHandler({
    requestHandler: handler,
    // AgentCore terminates SigV4 in front of the container (serveA2A does the
    // same); inside, requests are trusted.
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat: { enabled: true },
  }),
);

process.on('SIGTERM', () => {
  sigtermAt = Date.now();
  console.log(JSON.stringify({ event: 'sigterm', containerId: CONTAINER_ID, at: sigtermAt, liveTasks: live.size }));
  // Deliberately does NOT exit. The grace period between SIGTERM and the kill
  // is the number §C needs — it bounds what a cancelled run can finish, and
  // therefore whether side-effect recovery is possible at all. A heartbeat
  // makes it measurable: the last one logged is the moment the process died.
  const since = () => Date.now() - sigtermAt!;
  const beat = setInterval(() => {
    console.log(JSON.stringify({ event: 'post-sigterm', containerId: CONTAINER_ID, msSinceSigterm: since(), liveTasks: live.size }));
    if (since() > 180_000) clearInterval(beat);
  }, 500);
});
process.on('SIGINT', () => console.log(JSON.stringify({ event: 'sigint', containerId: CONTAINER_ID, at: Date.now() })));

app.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ event: 'listening', containerId: CONTAINER_ID, port: PORT }));
});
