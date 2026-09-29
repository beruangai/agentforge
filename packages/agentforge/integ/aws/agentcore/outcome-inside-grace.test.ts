/**
 * research §C — is the grace period USABLE?
 *
 * Knowing how long a stopped container has — about ten seconds on V2 — is
 * only half an answer. The
 * design question is whether it can still reach the network in them and record
 * an outcome — because if it cannot, "a side effect's recovery is the
 * consumer's" has nowhere to run and `LOST` is the only honest state.
 *
 * Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md): with a
 * 120 s task still running, the container wrote an outcome row to DynamoDB
 * from inside its SIGTERM handler — its first action, 0 ms after the signal —
 * and the row was visible 3.5 s after `StopRuntimeSession` returned.
 * Networking, credentials and the DynamoDB client all survive SIGTERM. Held
 * on V2, 2026-09-24.
 */
import { randomUUIDv7 } from 'node:crypto';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import { A2aOverAgentCore } from './__fixtures__/invocation.ts';
import {
  A2A_ONE_ZERO_ONLY_PROFILE,
  type FixtureRuntime,
  PROVISIONING_TIMEOUT_MILLISECONDS,
  provisionFixtureRuntime,
  TEARDOWN_TIMEOUT_MILLISECONDS,
} from './__fixtures__/provisioning.ts';
import {
  createResourceStack,
  releaseResources,
} from './__fixtures__/resources.ts';
import { waitForContainerLogEvents } from './__fixtures__/runtime-logs.ts';

/** The spike gave up after 12 s; the row appeared at 3.5 s. */
const OUTCOME_VISIBLE_WITHIN_MILLISECONDS = 12_000;
const LOG_CLOCK_MARGIN_MILLISECONDS = 60_000;

describe('an outcome recorded inside the grace period (research §C)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;
  let outcomeTableName: string;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'outcome',
      profile: A2A_ONE_ZERO_ONLY_PROFILE,
      outcomeTable: true,
    });
    if (fixture.outcomeTableName === undefined) {
      throw new Error('the runtime was provisioned without its outcome table');
    }
    outcomeTableName = fixture.outcomeTableName;
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
  }, PROVISIONING_TIMEOUT_MILLISECONDS);

  afterAll(
    () => releaseResources(resources, 'outcome-inside-grace'),
    TEARDOWN_TIMEOUT_MILLISECONDS,
  );

  it('lets a stopped container, mid-task, reach DynamoDB from its SIGTERM handler', async () => {
    const session = newRuntimeSessionId('outcome');
    await a2a.SendMessage(session, { runMilliseconds: 100 });
    const outcomeKey = `outcome-${randomUUIDv7()}`;
    // The container holds the target before it answers, so the stop can follow
    // at once.
    const { task } = await a2a.SendMessage(session, {
      runMilliseconds: 120_000,
      outcomeTarget: { tableName: outcomeTableName, key: outcomeKey },
    });

    const stopIssuedAt = Date.now();
    const stopped = await fixture.clients.data.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: fixture.runtime.agentRuntimeArn,
        runtimeSessionId: session,
      }),
    );
    expect(stopped.$metadata.httpStatusCode).toBe(200);

    const outcome = await vi.waitUntil(
      async () =>
        (
          await fixture.clients.dynamoDB.send(
            new GetItemCommand({
              TableName: outcomeTableName,
              Key: { outcomeKey: { S: outcomeKey } },
              ConsistentRead: true,
            }),
          )
        ).Item,
      { timeout: OUTCOME_VISIBLE_WITHIN_MILLISECONDS, interval: 500 },
    );
    expect(outcome.outcome?.S).toBe('RECORDED_DURING_SHUTDOWN');
    expect(outcome.containerId?.S).toBe(task.metadata.containerId);
    expect(outcome.liveTasksAtSigterm?.N).toBe('1');

    // The container's own account agrees: the write succeeded.
    const [written] = await waitForContainerLogEvents(
      fixture.clients.logs,
      {
        agentRuntimeId: fixture.runtime.agentRuntimeId,
        eventName: 'shutdown-outcome',
        containerId: task.metadata.containerId,
        startTime: stopIssuedAt - LOG_CLOCK_MARGIN_MILLISECONDS,
      },
      (events) => events.length > 0,
      120_000,
    );
    expect(written).toMatchObject({ written: true, errorName: null });
  }, 240_000);
});
