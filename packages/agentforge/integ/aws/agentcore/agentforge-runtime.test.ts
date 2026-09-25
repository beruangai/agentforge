/**
 * AgentForge's own server on AgentCore V2, deployed through the `AgentRuntime`
 * construct with the CDK CLI and reached through the client's
 * `agentCoreTransport` — SigV4, the session header, `A2A-Version` through the
 * allowlist — with task state in the table the construct deploys. No model:
 * the procedures are the runtime fixture's. What only a deployment can show:
 * CloudFormation honours `PlatformVersion`, which its reference lists without
 * describing; the deploy returns only once the runtime serves, so the first
 * call succeeds; ids minted in containers restored from one snapshot differ
 * (DESIGN_OPTIONS §H); a start and its retry attach through the platform; a
 * cancel reaches the container running the task; and a platform stop ends the
 * task `LOST` — read by a fresh container from the store — after which a
 * retry runs as the next attempt.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { awaitTask, createClient } from '../../../src/client/client.ts';
import { agentCoreTransport } from '../../../src/client/transport.ts';
import { runtimeContract } from '../../local/runtime/__fixtures__/contract.ts';
import {
  DEPLOYMENT_TIMEOUT_MILLISECONDS,
  deployAgentForgeRuntime,
} from './__fixtures__/agentforge-runtime-deployment.ts';
import {
  newRuntimeSessionId,
  resolveAwsEnvironment,
  resourceNamesFor,
} from './__fixtures__/aws-environment.ts';
import {
  type AgentCoreClients,
  createAgentCoreClients,
} from './__fixtures__/provisioning.ts';
import {
  createResourceStack,
  releaseResources,
} from './__fixtures__/resources.ts';

/** Fresh sessions at once, each a container restored from the one snapshot. */
const RESTORED_CONTAINERS = 8;

describe("AgentForge's server on AgentCore", () => {
  const resources = createResourceStack();
  let clients: AgentCoreClients;
  let agentRuntimeArn: string;
  let client: ReturnType<typeof createClient<typeof runtimeContract>>;

  beforeAll(async () => {
    const environment = await resolveAwsEnvironment();
    clients = createAgentCoreClients(environment.region);
    ({ agentRuntimeArn } = await deployAgentForgeRuntime(
      resources,
      clients,
      resourceNamesFor('agentforge'),
    ));
    client = createClient(
      runtimeContract,
      agentCoreTransport({ agentRuntimeArn, region: environment.region }),
    );
  }, DEPLOYMENT_TIMEOUT_MILLISECONDS);

  afterAll(
    () => releaseResources(resources, 'agentforge-runtime'),
    DEPLOYMENT_TIMEOUT_MILLISECONDS,
  );

  it('runs on platform version V2, as the construct declares', async () => {
    const agentRuntimeId = agentRuntimeArn.split('/').at(-1);
    const runtime = await clients.control.send(
      new GetAgentRuntimeCommand({ agentRuntimeId }),
    );
    expect(runtime.platformVersion).toBe('V2');
  });

  it('mints distinct ids in containers restored from one snapshot', async () => {
    const started = await Promise.all(
      Array.from({ length: RESTORED_CONTAINERS }, () =>
        client.echo.SendMessage(
          { text: 'restored' },
          {
            runtimeSessionId: newRuntimeSessionId('restored'),
            idempotencyKey: newRuntimeSessionId('key'),
          },
        ),
      ),
    );
    // Each task id is a uuid7 minted by that container's first request. Its
    // leading 48 bits are the time, so compare the random tail: a random
    // source not reseeded after the restore repeats it across containers.
    const randomTails = started.map(({ taskId }) =>
      taskId.replaceAll('-', '').slice(16),
    );
    expect(new Set(randomTails).size).toBe(RESTORED_CONTAINERS);
  });

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
    await clients.data.send(
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
