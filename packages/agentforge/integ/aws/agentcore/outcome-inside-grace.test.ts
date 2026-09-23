/**
 * §C — is the grace period USABLE?
 *
 * Knowing a stopped container has about 60 seconds is only half an answer. The
 * design question is whether it can still reach the network in them and record
 * an outcome — because if it cannot, "a side effect's recovery is the
 * consumer's" has nowhere to run and `LOST` is the only honest state.
 *
 * Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md): with a
 * 120 s task still running, the container wrote an outcome row to DynamoDB
 * from inside its SIGTERM handler — its first action, 0 ms after the signal —
 * and the row was visible 3.5 s after `StopRuntimeSession` returned.
 * Networking, credentials and the DynamoDB client all survive SIGTERM.
 */
import { randomUUIDv7 } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import { A2aOverAgentCore } from './__fixtures__/invocation.ts';
import {
  a2a10OnlyProfile,
  type FixtureRuntime,
  provisionFixtureRuntime,
  provisioningTimeoutMilliseconds,
  teardownTimeoutMilliseconds,
} from './__fixtures__/provisioning.ts';
import {
  createResourceStack,
  releaseResources,
} from './__fixtures__/resources.ts';
import { waitForContainerLogEvents } from './__fixtures__/runtime-logs.ts';

/** The spike gave up after 12 s; the row appeared at 3.5 s. */
const outcomeVisibleWithinMilliseconds = 12_000;
const logClockMarginMilliseconds = 60_000;

describe('an outcome recorded inside the grace period (§C)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;
  let leaseTableName: string;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'outcome',
      profile: a2a10OnlyProfile,
      leaseTable: true,
    });
    if (fixture.leaseTableName === undefined) {
      throw new Error('the runtime was provisioned without its lease table');
    }
    leaseTableName = fixture.leaseTableName;
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'outcome-inside-grace'),
    teardownTimeoutMilliseconds,
  );

  it('lets a stopped container, mid-task, reach DynamoDB from its SIGTERM handler', async () => {
    const session = newRuntimeSessionId('outcome');
    await a2a.SendMessage(session, { runMilliseconds: 100 });
    const leaseId = `outcome-${randomUUIDv7()}`;
    const { task } = await a2a.SendMessage(session, {
      runMilliseconds: 120_000,
      lease: {
        tableName: leaseTableName,
        leaseId,
        renewMilliseconds: 5_000,
        renewals: 40,
      },
    });

    await setTimeout(3_000);
    const stopIssuedAt = Date.now();
    const stopped = await fixture.clients.data.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: fixture.runtime.agentRuntimeArn,
        runtimeSessionId: session,
      }),
    );
    const stopReturnedAt = Date.now();
    expect(stopped.$metadata.httpStatusCode).toBe(200);

    const outcome = await vi.waitUntil(
      async () =>
        (
          await fixture.clients.dynamo.send(
            new GetItemCommand({
              TableName: leaseTableName,
              Key: { leaseId: { S: `${leaseId}#outcome` } },
              ConsistentRead: true,
            }),
          )
        ).Item,
      { timeout: outcomeVisibleWithinMilliseconds, interval: 500 },
    );
    expect(Date.now() - stopReturnedAt).toBeLessThan(
      outcomeVisibleWithinMilliseconds,
    );
    expect(outcome.outcome?.S).toBe('RECORDED_DURING_SHUTDOWN');
    expect(outcome.containerId?.S).toBe(task.metadata.containerId);
    expect(outcome.liveTasksAtSigterm?.N).toBe('1');
    // The handler's first action.
    expect(Number(outcome.recordedAfterSigtermMilliseconds?.N)).toBeLessThan(
      1_000,
    );

    // The container's own account agrees: the write succeeded.
    const [written] = await waitForContainerLogEvents(
      fixture.clients.logs,
      {
        agentRuntimeId: fixture.runtime.agentRuntimeId,
        eventName: 'shutdown-outcome',
        containerId: task.metadata.containerId,
        startTime: stopIssuedAt - logClockMarginMilliseconds,
      },
      (events) => events.length > 0,
      120_000,
    );
    expect(written).toMatchObject({ written: true, errorName: null });
  }, 240_000);
});
