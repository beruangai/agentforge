/**
 * AgentForge's own server on AgentCore V2, reached through the client's
 * `agentCoreTransport` — SigV4, the session header, `A2A-Version` through the
 * allowlist — with task state in real DynamoDB. No model: the procedures are
 * the runtime fixture's. What only AgentCore can show: a start and its retry
 * attach through the platform, a cancel reaches the container running the
 * task, and a platform stop ends the task `LOST` — read by a fresh container
 * from the store — after which a retry runs as the next attempt.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import {
  DeleteTableCommand,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awaitTask, createClient } from '../../../src/client/client.ts';
import { agentCoreTransport } from '../../../src/client/transport.ts';
import { createTaskTable } from '../../../src/server/runtime/task-store.ts';
import { runtimeContract } from '../../local/runtime/__fixtures__/contract.ts';
import {
  describeError,
  waitForAgentRuntimeReady,
} from './__fixtures__/agent-runtime-status.ts';
import { buildAndPushAgentForgeRuntimeImage } from './__fixtures__/agentforge-runtime-image.ts';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import {
  createAgentRuntime,
  type PreparedFixtureImage,
  prepareFixtureImage,
  provisioningTimeoutMilliseconds,
  teardownTimeoutMilliseconds,
} from './__fixtures__/provisioning.ts';
import {
  createResourceStack,
  releaseResources,
} from './__fixtures__/resources.ts';

describe("AgentForge's server on AgentCore", () => {
  const resources = createResourceStack();
  let prepared: PreparedFixtureImage;
  let agentRuntimeArn: string;
  let client: ReturnType<typeof createClient<typeof runtimeContract>>;

  beforeAll(async () => {
    prepared = await prepareFixtureImage(
      resources,
      'agentforge',
      buildAndPushAgentForgeRuntimeImage,
    );
    const tableName = prepared.names.outcomeTableName;
    const { dynamoDB } = prepared.clients;
    await createTaskTable(dynamoDB, tableName);
    resources.defer(async () => {
      try {
        await dynamoDB.send(new DeleteTableCommand({ TableName: tableName }));
        await waitUntilTableNotExists(
          { client: dynamoDB, maxWaitTime: 300 },
          { TableName: tableName },
        );
      } catch (error) {
        throw new Error(
          `DynamoDB table ${tableName}: ${describeError(error)}`,
          {
            cause: error,
          },
        );
      }
    });
    const runtime = await createAgentRuntime(resources, prepared, {
      profile: {
        environmentVariables: { AGENTFORGE_TABLE_NAME: tableName },
        requestHeaderAllowlist: ['A2A-Version'],
      },
    });
    await waitForAgentRuntimeReady(prepared.clients.control, runtime);
    agentRuntimeArn = runtime.agentRuntimeArn;
    client = createClient(
      runtimeContract,
      agentCoreTransport({
        agentRuntimeArn,
        region: prepared.environment.region,
      }),
    );
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'agentforge-runtime'),
    teardownTimeoutMilliseconds,
  );

  it('runs a procedure to its typed output, and attaches a retry to it', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId('echo'),
      idempotencyKey: newRuntimeSessionId('key'),
    };
    const started = await client.echo.SendMessage({ text: 'hello' }, context);
    const ended = await awaitTask(client.echo, started, {
      ...context,
      pollIntervalMilliseconds: 500,
    });
    expect(ended).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
      output: { text: 'hello', attempt: 1 },
    });
    const retry = await client.echo.SendMessage({ text: 'hello' }, context);
    expect(retry).toMatchObject({
      taskId: started.taskId,
      state: 'TASK_STATE_COMPLETED',
    });
  });

  it('cancels a running task', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId('cancel'),
      idempotencyKey: newRuntimeSessionId('key'),
    };
    const started = await client.wait.SendMessage(
      { milliseconds: 120_000 },
      context,
    );
    await delay(2_000);
    const cancelled = await client.CancelTask(started.taskId, context);
    expect(cancelled.state).toBe('TASK_STATE_CANCELED');
  });

  it('ends a task LOST when the platform stops its container, and runs the retry as the next attempt', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId('stop'),
      idempotencyKey: newRuntimeSessionId('key'),
    };
    const started = await client.wait.SendMessage(
      { milliseconds: 120_000 },
      context,
    );
    await delay(2_000);
    await prepared.clients.data.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn,
        runtimeSessionId: context.runtimeSessionId,
      }),
    );
    // The next call lands on a fresh container, which reads the task from the
    // store: LOST from the stopped container's own shutdown, or from its lease.
    const ended = await awaitTask(client.wait, started, {
      ...context,
      pollIntervalMilliseconds: 2_000,
    });
    expect(ended).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'LOST', retryable: true },
    });
    const retry = await client.wait.SendMessage({ milliseconds: 100 }, context);
    expect(retry.taskId).not.toBe(started.taskId);
    const retried = await awaitTask(client.wait, retry, {
      ...context,
      pollIntervalMilliseconds: 500,
    });
    expect(retried).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
      attempt: 2,
    });
  }, 300_000);
});
