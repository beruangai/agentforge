/**
 * The runtime end to end in one process, without a model: a real A2A server,
 * real task processes, DynamoDB Local. What AgentForge itself guarantees —
 * idempotency, attempts, cancellation that takes the whole process group, the
 * time budget, loss, fencing, admission — exercised through the client a
 * caller uses.
 */
import { randomUUIDv7 } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { oc } from '@orpc/contract';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  awaitTask,
  createClient,
  type Routed,
} from '../../../src/client/client.ts';
import { localTransport } from '../../../src/client/transport.ts';
import { finishedTask, newTask } from '../../../src/server/runtime/a2a-task.ts';
import {
  type RunningServer,
  startServer,
} from '../../../src/server/runtime/server.ts';
import { DynamoDBTaskStore } from '../../../src/server/runtime/task-store.ts';
import {
  type DynamoDBLocal,
  startDynamoDBLocal,
} from '../../__fixtures__/dynamodb-local.ts';
import { runtimeContract } from './__fixtures__/contract.ts';

let dynamoDB: DynamoDBLocal;
let tableName: string;
let server: RunningServer;
let client: ReturnType<typeof createClient<typeof runtimeContract>>;

const routed = (): Routed => ({
  runtimeSessionId: `session-${randomUUIDv7()}`,
});
const starting = (key = randomUUIDv7()) => ({
  ...routed(),
  idempotencyKey: key,
});

beforeAll(async () => {
  // DynamoDB Local takes any credentials; nothing here may reach AWS.
  delete process.env.AWS_PROFILE;
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  process.env.AWS_REGION = 'us-east-2';
  dynamoDB = await startDynamoDBLocal();
  tableName = await dynamoDB.createTable();
  server = await startServer({
    agentName: 'runtime-integ',
    taskCommand: [
      'bun',
      join(import.meta.dirname, '__fixtures__', 'task-entry.ts'),
    ],
    tableName,
    dynamoDBEndpoint: dynamoDB.endpoint,
    admissionLimit: 3,
    defaultTimeBudgetSeconds: 60,
    port: 0,
    host: '127.0.0.1',
  });
  client = createClient(runtimeContract, localTransport(server.url));
});

afterAll(async () => {
  await server?.close();
  dynamoDB?.stop();
});

describe('the runtime', () => {
  it('runs a procedure to its typed output', async () => {
    const context = starting();
    const started = await client.echo.SendMessage({ text: 'hello' }, context);
    expect(['TASK_STATE_SUBMITTED', 'TASK_STATE_WORKING']).toContain(
      started.state,
    );
    const ended = await awaitTask(client.echo, started, {
      ...context,
      pollIntervalMilliseconds: 100,
    });
    expect(ended).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
      output: { text: 'hello', attempt: 1 },
    });
  });

  it('attaches a retry to the running task, and later to its outcome', async () => {
    const context = starting();
    const first = await client.wait.SendMessage(
      { milliseconds: 1_500 },
      context,
    );
    const retry = await client.wait.SendMessage(
      { milliseconds: 1_500 },
      context,
    );
    expect(retry.taskId).toBe(first.taskId);
    await awaitTask(client.wait, first, {
      ...context,
      pollIntervalMilliseconds: 100,
    });
    const later = await client.wait.SendMessage(
      { milliseconds: 1_500 },
      context,
    );
    expect(later).toMatchObject({
      taskId: first.taskId,
      state: 'TASK_STATE_COMPLETED',
    });
  });

  it('starts a new attempt once the previous one failed, telling it how', async () => {
    const context = starting();
    const first = await awaitTask(
      client.flaky,
      await client.flaky.SendMessage({}, context),
      {
        ...context,
        pollIntervalMilliseconds: 100,
      },
    );
    expect(first).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'PROVIDER_TRANSIENT', retryable: true },
    });
    const second = await awaitTask(
      client.flaky,
      await client.flaky.SendMessage({}, context),
      {
        ...context,
        pollIntervalMilliseconds: 100,
      },
    );
    expect(second).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
      attempt: 2,
      output: { attempt: 2, priorState: 'TASK_STATE_FAILED' },
    });
  });

  it('cancels a running task cooperatively', async () => {
    const context = starting();
    const started = await client.wait.SendMessage(
      { milliseconds: 60_000 },
      context,
    );
    await vi.waitUntil(
      async () =>
        (await client.wait.GetTask(started.taskId, context)).state ===
        'TASK_STATE_WORKING',
    );
    const cancelled = await client.CancelTask(started.taskId, context);
    expect(cancelled.state).toBe('TASK_STATE_CANCELED');
  });

  it('kills the whole process group of a task that ignores its cancel', async () => {
    const context = starting();
    const pidFile = join(
      mkdtempSync(join(tmpdir(), 'agentforge-')),
      'grandchild.pid',
    );
    const started = await client.stubborn.SendMessage({ pidFile }, context);
    await vi.waitUntil(() => existsSync(pidFile), { timeout: 10_000 });
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    const cancelled = await client.CancelTask(started.taskId, context);
    expect(cancelled.state).toBe('TASK_STATE_CANCELED');
    await vi.waitUntil(() => !isRunning(grandchild), { timeout: 5_000 });
  }, 30_000);

  it('fails a task whose time budget runs out', async () => {
    const context = { ...starting(), timeBudgetSeconds: 1 };
    const ended = await awaitTask(
      client.wait,
      await client.wait.SendMessage({ milliseconds: 60_000 }, context),
      {
        ...context,
        pollIntervalMilliseconds: 200,
      },
    );
    expect(ended).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'TIMED_OUT' },
    });
  });

  it('records a crash with the tail of its stderr', async () => {
    const context = starting();
    const ended = await awaitTask(
      client.crash,
      await client.crash.SendMessage({}, context),
      {
        ...context,
        pollIntervalMilliseconds: 100,
      },
    );
    expect(ended).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'EXECUTION_ERROR' },
    });
    if (ended.state !== 'TASK_STATE_FAILED') throw new Error('unreachable');
    expect(ended.cause.message).toContain('about to crash on purpose');
  });

  it('rejects a caller compiled against a different contract, before any work', async () => {
    const drifted = createClient(
      {
        echo: oc
          .input(z.object({ text: z.string(), extra: z.number() }))
          .output(z.object({ text: z.string(), attempt: z.number() })),
      },
      localTransport(server.url),
    );
    const context = starting();
    const ended = await awaitTask(
      drifted.echo,
      await drifted.echo.SendMessage({ text: 'x', extra: 1 }, context),
      {
        ...context,
        pollIntervalMilliseconds: 100,
      },
    );
    expect(ended.state).toBe('TASK_STATE_REJECTED');
  });

  it('rejects a start beyond the admission limit rather than queueing it', async () => {
    const contexts = [starting(), starting(), starting()];
    const running = await Promise.all(
      contexts.map((context) =>
        client.wait.SendMessage({ milliseconds: 60_000 }, context),
      ),
    );
    const refused = await client.wait.SendMessage(
      { milliseconds: 1 },
      starting(),
    );
    expect(refused.state).toBe('TASK_STATE_REJECTED');
    await Promise.all(
      running.map((task, index) =>
        client.CancelTask(task.taskId, contexts[index] as Routed),
      ),
    );
  });

  it('reports busy on /ping while a task runs', async () => {
    const context = starting();
    const started = await client.wait.SendMessage(
      { milliseconds: 60_000 },
      context,
    );
    const ping = await fetch(new URL('/ping', server.url)).then((response) =>
      response.json(),
    );
    expect(ping).toEqual({ status: 'HealthyBusy' });
    await client.CancelTask(started.taskId, context);
    const idle = await fetch(new URL('/ping', server.url)).then((response) =>
      response.json(),
    );
    expect(idle).toEqual({ status: 'Healthy' });
  });
});

describe('the task store', () => {
  it('derives a task lost once its lease lapses, and refuses a later write over it', async () => {
    const store = new DynamoDBTaskStore(dynamoDB.client, tableName);
    const task = newTask({
      id: randomUUIDv7(),
      contextId: randomUUIDv7(),
      state: 'TASK_STATE_WORKING',
      metadata: {},
    });
    await store.save(task);
    // The container died: nothing renews the lease. Age it past its expiry.
    const { UpdateItemCommand } = await import('@aws-sdk/client-dynamodb');
    await dynamoDB.client.send(
      new UpdateItemCommand({
        TableName: tableName,
        Key: { pk: { S: `task#${task.id}` } },
        UpdateExpression: 'SET leaseExpiresAt = :past',
        ExpressionAttributeValues: { ':past': { N: String(Date.now() - 1) } },
      }),
    );
    const lost = await store.load(task.id);
    expect(lost?.artifacts[0]?.parts[0]?.content).toMatchObject({
      value: { state: 'TASK_STATE_FAILED', cause: { code: 'LOST' } },
    });
    await expect(
      store.save(
        finishedTask(task, { state: 'TASK_STATE_COMPLETED', output: {} }),
      ),
    ).rejects.toThrow(/already ended/);
  });
});

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
