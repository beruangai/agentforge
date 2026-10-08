import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { AgentCard } from '@a2a-js/sdk';
import { DefaultRequestHandler } from '@a2a-js/sdk/server';
import { jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import express from 'express';
import { z } from 'zod';
import { A2A_PROTOCOL_VERSION } from '#core/a2a-version.ts';
import { AGENT_NAME_VARIABLE } from '#core/agent-name.ts';
import { RUNTIME_SESSION_HEADER } from '#core/contract/envelope.ts';
import { TimeBudgetSecondsField } from '#core/contract/procedures.ts';
import { SecretNameSchema } from '#core/secrets.ts';
import { TASK_TABLE_NAME_VARIABLE } from '#core/task-table.ts';
import { TaskProcessExecutor } from './executor.ts';
import { createGateway } from './gateway.ts';
import { createOperationalMetrics } from './metrics.ts';
import { requireSecrets, resolveDeclaredSecrets } from './secrets.ts';
import { createTaskTable, DynamoDBTaskStore } from './task-store.ts';
import { startTelemetry, type Telemetry } from './telemetry.ts';

export interface ServerConfig {
  /** The agent's name, on its card and in its records. */
  readonly agentName: string;
  /**
   * The consumer's task entry: the module that calls `runTaskProcess`, run
   * once per task by this same runtime with the same flags, so its export
   * conditions carry over. `new URL('./task.ts', import.meta.url)`.
   */
  readonly taskEntry: string | URL;
  /**
   * The secrets the agent's layers require, by the environment variable each
   * becomes, beside AgentForge's own: the base layer's and the agent's
   * `REQUIRED_SECRETS`. A request fails while one is unset.
   */
  readonly requiredSecrets: readonly string[];
  /** The DynamoDB table holding task state. */
  readonly tableName: string;
  /** A DynamoDB endpoint other than AWS's — DynamoDB Local, in development. */
  readonly dynamoDBEndpoint?: string;
  /** Tasks run at once before a start is refused. */
  readonly admissionLimit: number;
  /** A task's time budget when its start sets none (§REQ202). */
  readonly defaultTimeBudgetSeconds: number;
  /** AgentCore's contract port is 9000. */
  readonly port: number;
  readonly host: string;
}

/** The task entry, the required secrets, and anything else the environment should not decide. */
export type ServerOptions = Pick<
  ServerConfig,
  'taskEntry' | 'requiredSecrets'
> &
  Partial<ServerConfig>;

/**
 * The configuration: what the server entry passes, the rest from the
 * environment, which is how a container gets it. A missing required value
 * fails here, loudly, rather than at first use.
 */
function serverConfig(
  options: ServerOptions,
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const required = (name: string): string => {
    const value = environment[name];
    if (value === undefined || value === '') {
      throw new Error(`${name} must be set to start the AgentForge server`);
    }
    return value;
  };
  const positiveInteger = (name: string, fallback: number): number => {
    const value = environment[name];
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer, not "${value}"`);
    }
    return parsed;
  };
  const endpoint =
    options.dynamoDBEndpoint ?? environment.AGENTFORGE_DYNAMODB_ENDPOINT;
  return {
    taskEntry: options.taskEntry,
    requiredSecrets: z.array(SecretNameSchema).parse(options.requiredSecrets),
    agentName: options.agentName ?? required(AGENT_NAME_VARIABLE),
    tableName: options.tableName ?? required(TASK_TABLE_NAME_VARIABLE),
    ...(endpoint === undefined || endpoint === ''
      ? {}
      : { dynamoDBEndpoint: endpoint }),
    admissionLimit:
      options.admissionLimit ??
      positiveInteger('AGENTFORGE_ADMISSION_LIMIT', 4),
    // Whole seconds the executor's timer can hold, however it is given.
    defaultTimeBudgetSeconds: TimeBudgetSecondsField.parse(
      options.defaultTimeBudgetSeconds ??
        positiveInteger('AGENTFORGE_TIME_BUDGET_SECONDS', 3_600),
    ),
    port: options.port ?? positiveInteger('AGENTFORGE_PORT', 9_000),
    host: options.host ?? environment.AGENTFORGE_HOST ?? '0.0.0.0',
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
  options: ServerOptions,
): Promise<RunningServer> {
  const config = serverConfig(options);
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
  const metrics = createOperationalMetrics();
  const store = new DynamoDBTaskStore(
    dynamoDB,
    config.tableName,
    config.agentName,
    metrics,
  );
  const executor = new TaskProcessExecutor({
    taskCommand: [
      process.execPath,
      ...process.execArgv,
      config.taskEntry instanceof URL
        ? fileURLToPath(config.taskEntry)
        : config.taskEntry,
    ],
    agentName: config.agentName,
    defaultTimeBudgetSeconds: config.defaultTimeBudgetSeconds,
    graceMilliseconds: GRACE_MILLISECONDS,
    store,
    metrics,
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
  // AgentCore snapshots the container at its first healthy /ping, and every
  // instance restored from it replays any randomness drawn before it — Bun's
  // generator is not snapshot-safe, and TLS draws from it too. So startup
  // draws none: the secrets and the collector, which need the network, are
  // prepared on the first request after the restore, before any task.
  let telemetry: Telemetry | undefined;
  let prepared: Promise<void> | undefined;
  const prepare = (runtimeSessionId: string | undefined): Promise<void> => {
    prepared ??= (async () => {
      // Before the secrets, so the collector's environment holds none.
      telemetry = await startTelemetry({
        agentName: config.agentName,
        ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
      });
      await resolveDeclaredSecrets();
      requireSecrets(config.requiredSecrets);
    })();
    return prepared;
  };
  app.post('/', (request, response, next) => {
    prepare(request.get(RUNTIME_SESSION_HEADER)).then(
      () => next(),
      (error: unknown) => {
        console.error('the container could not be prepared', error);
        response.status(500).json({
          jsonrpc: '2.0',
          id: (request.body as { id?: unknown } | undefined)?.id ?? null,
          error: {
            code: -32603,
            message: `the container could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
          },
        });
      },
    );
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
    // Refuses every start from here on, then stops the tasks already running.
    await executor.shutdown();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await metrics.flush();
    // Last, so it flushes what the stopped tasks' CLIs exported.
    await prepared?.catch(() => undefined);
    await telemetry?.stop();
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
      {
        url,
        protocolBinding: 'JSONRPC',
        tenant: '',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
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
