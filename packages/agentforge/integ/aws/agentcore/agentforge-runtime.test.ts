/**
 * AgentForge's own server on AgentCore V2, deployed through the `AgentRuntime`
 * construct with the CDK CLI and reached through the client's
 * `agentCoreTransport` — SigV4, the session header, `A2A-Version` through the
 * allowlist — with task state in the table the construct deploys. No model:
 * the procedures are the runtime fixture's. What only a deployment can show:
 * CloudFormation honours `PlatformVersion`, which its reference lists without
 * describing; the deploy returns only once the runtime serves, so the first
 * call succeeds; ids minted in containers restored from one snapshot differ
 * — deployed with a declared secret and telemetry on, whose preparation on
 * the first request must draw no randomness before the snapshot, as Bun's
 * generator replays it in every restored instance; calls overlapping a new
 * session's first, which AgentCore refuses while it creates the container,
 * are repeated by the transport until they reach it; a start and its retry attach through the platform; a
 * cancel reaches the container running the task; and a platform stop ends the
 * task `LOST` — read by a fresh container from the store — after which a
 * retry runs as the next attempt.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import {
  paginateDescribeLogGroups,
  paginateFilterLogEvents,
} from '@aws-sdk/client-cloudwatch-logs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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
import { runtimeLogGroupNamePrefix } from './__fixtures__/runtime-logs.ts';

/** Fresh sessions at once, each a container restored from the one snapshot. */
const RESTORED_CONTAINERS = 8;
/** Span delivery through X-Ray to the log group lags by minutes. */
const SPAN_DELIVERY_TIMEOUT_MILLISECONDS = 600_000;

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
    // Each task id is the A2A SDK's crypto.randomUUID(), the first a restored
    // container mints. Bun's generator replays across restores once drawn
    // from before the snapshot, so a draw at startup — here or in a
    // dependency — repeats it in every container.
    const randomTails = started.map(({ taskId }) =>
      taskId.replaceAll('-', '').slice(16),
    );
    expect(new Set(randomTails).size).toBe(RESTORED_CONTAINERS);
  });

  it('answers calls that overlap the first to a new session, which AgentCore refuses while it creates the container', async () => {
    const runtimeSessionId = newRuntimeSessionId('overlap');
    const answered = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        client.echo.GetTask(newRuntimeSessionId('unknown'), {
          runtimeSessionId,
        }),
      ),
    );
    // Each reached the server, which knows no such task: none was left refused.
    for (const outcome of answered) {
      expect(outcome).toMatchObject({
        status: 'rejected',
        reason: { name: 'AgentForgeRequestError', code: -32001 },
      });
    }
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

  // Held: on 2026-09-26 no span reached the runtime's own log group within
  // ten minutes; they land in the shared `aws/spans` group instead. Rewritten
  // to read there, and enabled, once it is decided the check earns its place.
  it.skip(
    "delivers the runtime's service spans to its own log group",
    async () => {
      // The invocations of the tests above are what the spans record.
      const agentRuntimeId = agentRuntimeArn.split('/').at(-1);
      if (agentRuntimeId === undefined) {
        throw new Error(`no runtime id in ${agentRuntimeArn}`);
      }
      await vi.waitUntil(
        async () => {
          for await (const groupPage of paginateDescribeLogGroups(
            { client: clients.logs },
            { logGroupNamePrefix: runtimeLogGroupNamePrefix(agentRuntimeId) },
          )) {
            for (const { logGroupName } of groupPage.logGroups ?? []) {
              for await (const page of paginateFilterLogEvents(
                { client: clients.logs },
                { logGroupName, logStreamNamePrefix: 'spans', limit: 1 },
              )) {
                if ((page.events ?? []).length > 0) {
                  return true;
                }
              }
            }
          }
          return false;
        },
        { timeout: SPAN_DELIVERY_TIMEOUT_MILLISECONDS, interval: 15_000 },
      );
    },
    SPAN_DELIVERY_TIMEOUT_MILLISECONDS + 60_000,
  );
});
