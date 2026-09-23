/**
 * An A2A server on `@a2a-js/sdk` and Express, in this process, that records
 * what its executor is handed. Two are started side by side: strict (one 1.0
 * interface, `legacyCompat` off — AgentForge's configuration, ADR 0014) and
 * permissive (1.0 and 0.3, `legacyCompat` on).
 *
 * Unlike the AgentCore container, the executor here does NOT refuse a part it
 * cannot decode: it records it, so the test can observe what the SDK delivers
 * — including a part whose content it silently dropped.
 */
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { type Part, TaskState } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutor,
  DefaultRequestHandler,
  type ExecutionEventBus,
  InMemoryTaskStore,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import express from 'express';
import {
  buildFixtureAgentCard,
  type FixtureAgentCard,
} from '../../__fixtures__/agent-card.ts';

export interface ReceivedMessage {
  /** What `ServerCallContext.requestedVersion` held: the negotiated version. */
  readonly negotiatedVersion: string;
  /** The parts as the SDK parsed them and handed them to the executor. */
  readonly parts: Part[];
}

export interface VersionNegotiationServer {
  readonly url: string;
  readonly agentCard: FixtureAgentCard;
  readonly received: ReceivedMessage[];
  close(): Promise<void>;
}

class RecordingExecutor implements AgentExecutor {
  readonly received: ReceivedMessage[] = [];

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const message = requestContext.request.message;
    if (message === undefined)
      throw new Error('the request carries no message');
    const parts = message.parts;
    const negotiatedVersion = requestContext.context.requestedVersion;
    this.received.push({ negotiatedVersion, parts: structuredClone(parts) });
    const [dataPart] = parts.filter((part) => part.content?.$case === 'data');
    const data: unknown =
      dataPart?.content?.$case === 'data' ? dataPart.content.value : undefined;
    const idempotencyKey =
      typeof data === 'object' &&
      data !== null &&
      'idempotencyKey' in data &&
      typeof data.idempotencyKey === 'string'
        ? data.idempotencyKey
        : null;
    eventBus.publish(
      AgentEvent.task({
        id: requestContext.taskId,
        contextId: requestContext.contextId,
        status: {
          state: TaskState.TASK_STATE_COMPLETED,
          message: undefined,
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [],
        // Echoed so a probe can tell its own payload arrived.
        metadata: { negotiatedVersion, idempotencyKey },
      }),
    );
    eventBus.finished();
  }

  async cancelTask(): Promise<void> {
    throw new Error('the version negotiation fixture never cancels');
  }
}

export async function startVersionNegotiationServer(options: {
  strict10: boolean;
}): Promise<VersionNegotiationServer> {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}/`;

  const agentCard = buildFixtureAgentCard({ url, strict10: options.strict10 });
  const executor = new RecordingExecutor();
  app.get('/.well-known/agent-card.json', (_request, response) => {
    response.json(agentCard);
  });
  app.use(
    jsonRpcHandler({
      requestHandler: new DefaultRequestHandler(
        agentCard,
        new InMemoryTaskStore(),
        executor,
      ),
      userBuilder: UserBuilder.noAuthentication,
      legacyCompat: { enabled: !options.strict10 },
    }),
  );

  return {
    url,
    agentCard,
    received: executor.received,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
