import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import express from 'express';
import { TaskProcessExecutor } from './executor.ts';
import { createGateway } from './gateway.ts';
import { createTaskTable, DynamoDBTaskStore } from './task-store.ts';

export interface ServerConfig {
  /** The agent's name, on its card and in its records. */
  readonly agentName: string;
  /** The command that starts a task process — the consumer's task entry. */
  readonly taskCommand: readonly string[];
  /** The DynamoDB table holding task state. */
  readonly tableName: string;
  /** A DynamoDB endpoint other than AWS's — DynamoDB Local, in development. */
  readonly dynamoDBEndpoint?: string;
  /** Tasks run at once before a start is rejected. */
  readonly admissionLimit: number;
  /** A task's time budget when its start sets none (§REQ202). */
  readonly defaultTimeBudgetSeconds: number;
  /** AgentCore's contract port is 9000. */
  readonly port: number;
  readonly host: string;
}

/**
 * The configuration from the environment, which is how a container gets it.
 * A missing required value fails here, loudly, rather than at first use.
 */
export function serverConfigFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const required = (name: string): string => {
    const value = environment[name];
    if (value === undefined || value === '') {
      throw new Error(`${name} must be set to start the AgentForge server`);
    }
    return value;
  };
  const positive = (name: string, fallback: number): number => {
    const value = environment[name];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive number, not "${value}"`);
    }
    return parsed;
  };
  const endpoint = environment.AGENTFORGE_DYNAMODB_ENDPOINT;
  return {
    agentName: required('AGENTFORGE_AGENT_NAME'),
    taskCommand: JSON.parse(required('AGENTFORGE_TASK_COMMAND')) as string[],
    tableName: required('AGENTFORGE_TABLE_NAME'),
    ...(endpoint === undefined || endpoint === ''
      ? {}
      : { dynamoDBEndpoint: endpoint }),
    admissionLimit: positive('AGENTFORGE_ADMISSION_LIMIT', 4),
    defaultTimeBudgetSeconds: positive('AGENTFORGE_TIME_BUDGET_SECONDS', 3_600),
    port: positive('AGENTFORGE_PORT', 9_000),
    host: environment.AGENTFORGE_HOST ?? '0.0.0.0',
  };
}

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/** Grace for a stopping task: inside the ~10 s AgentCore gives a stopped container. */
const GRACE_MILLISECONDS = 5_000;

/**
 * The container's one server, on AgentCore's contract: A2A 1.0 JSON-RPC on
 * `POST /`, the card, and `/ping` reporting busy while any task runs.
 */
export async function startServer(
  config: ServerConfig = serverConfigFromEnvironment(),
): Promise<RunningServer> {
  const dynamoDB = new DynamoDBClient(
    config.dynamoDBEndpoint === undefined
      ? {}
      : { endpoint: config.dynamoDBEndpoint },
  );
  // Against DynamoDB Local the server makes its own table; in the cloud the
  // construct owns it, and a missing one fails the first task loudly.
  if (config.dynamoDBEndpoint !== undefined) {
    await createTaskTable(dynamoDB, config.tableName);
  }
  const store = new DynamoDBTaskStore(dynamoDB, config.tableName);
  const executor = new TaskProcessExecutor({
    taskCommand: config.taskCommand,
    defaultTimeBudgetSeconds: config.defaultTimeBudgetSeconds,
    graceMilliseconds: GRACE_MILLISECONDS,
    store,
  });

  const app = express();
  // AgentCore forwards whatever content type the caller sent; parse regardless.
  app.use(express.json({ limit: '10mb', type: () => true }));
  app.get('/ping', (_request, response) => {
    response.json({
      status: executor.liveCount > 0 ? 'HealthyBusy' : 'Healthy',
    });
  });

  const server = app.listen(config.port, config.host);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const url =
    process.env.AGENTCORE_RUNTIME_URL ?? `http://${config.host}:${port}/`;
  const card = agentCard(config.agentName, url);
  const inner = new DefaultRequestHandler(card, store, executor);
  const gateway = createGateway({
    inner,
    executor,
    store,
    admissionLimit: config.admissionLimit,
  });
  app.get('/.well-known/agent-card.json', (_request, response) => {
    response.json(card);
  });
  app.use(
    jsonRpcHandler({
      requestHandler: gateway,
      // AgentCore terminates authentication in front of the container.
      userBuilder: UserBuilder.noAuthentication,
      // A2A 1.0 only (ADR 0014): a missing A2A-Version header is refused, not downgraded.
      legacyCompat: { enabled: false },
    }),
  );

  const close = async (): Promise<void> => {
    await executor.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  };
  process.once('SIGTERM', () => {
    close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('the server did not stop cleanly', error);
        process.exit(1);
      },
    );
  });
  return { url, close };
}

function agentCard(name: string, url: string): AgentCard {
  return {
    name,
    description: `AgentForge agent ${name}`,
    version: '1.0.0',
    provider: undefined,
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: name,
        name,
        description: 'Runs this agent’s procedures as tasks',
        tags: ['agentforge'],
        examples: [],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
