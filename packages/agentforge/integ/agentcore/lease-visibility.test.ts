/**
 * §A — the lease, written and renewed from inside a microVM.
 *
 * Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md): on-demand
 * DynamoDB in the runtime's region, six renewals at a 2 s interval. A write
 * took a median 7 ms (range 6–67 ms; the 67 ms is the SDK's first call);
 * write → visible to an eventually-consistent read a median 11 ms (range
 * 9–72 ms); and the first read-back saw the new generation EVERY time, 6/6. So
 * DynamoDB's propagation is not a factor to design around at this item size
 * and rate, and a strongly-consistent read buys nothing.
 *
 * Clocks, and why the measurement is taken inside. A first version polled
 * DynamoDB from a laptop and reported ~322 ms "visibility", which conflated the
 * write, DynamoDB's propagation, a ~240 ms read RTT from outside AWS and a
 * ~333 ms apparent offset between two unsynchronised clocks — none of it a
 * platform number. So the container writes AND reads back, on ONE clock over
 * ONE network, and logs each renewal; this reads those logs. What an external
 * reader adds is its own RTT, which depends on where the caller runs, so it is
 * not asserted.
 */
import { randomUUIDv7 } from 'node:crypto';
import { GetItemCommand } from '@aws-sdk/client-dynamodb';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import { A2aOverAgentCore, taskFrom } from './__fixtures__/invocation.ts';
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
import {
  readContainerLogEvents,
  waitForContainerLogEvents,
} from './__fixtures__/runtime-logs.ts';

const renewMilliseconds = 2_000;
const renewals = 6;
/** The first write carries the SDK's own first-call cost (67 ms observed). */
const firstWriteWithinMilliseconds = 250;
/** Every later write: 6–7 ms observed. */
const writeWithinMilliseconds = 50;
/** Every later write → visible: 9–11 ms observed. */
const visibleWithinMilliseconds = 100;
const logClockMarginMilliseconds = 60_000;

describe('a lease renewed from inside a microVM (§A)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;
  let leaseTableName: string;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'lease',
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
    () => releaseResources(resources, 'lease-visibility'),
    teardownTimeoutMilliseconds,
  );

  it('writes each renewal in milliseconds, and the first eventually-consistent read-back always sees it', async () => {
    const session = newRuntimeSessionId('lease');
    // Warm the session and the client.
    await a2a.SendMessage(session, { runMilliseconds: 100 });

    const leaseId = `lease-${randomUUIDv7()}`;
    const runMilliseconds = renewMilliseconds * renewals + 4_000;
    const startedAt = Date.now();
    const { task } = await a2a.SendMessage(session, {
      runMilliseconds,
      lease: {
        tableName: leaseTableName,
        leaseId,
        renewMilliseconds,
        renewals,
      },
    });
    const query = {
      agentRuntimeId: fixture.runtime.agentRuntimeId,
      containerId: task.metadata.containerId,
      startTime: startedAt - logClockMarginMilliseconds,
    };

    const measured = (
      await waitForContainerLogEvents(
        fixture.clients.logs,
        { ...query, eventName: 'lease' },
        (events) =>
          events.filter((event) => event.leaseId === leaseId).length >=
          renewals,
        runMilliseconds + 120_000,
      )
    )
      .filter((event) => event.leaseId === leaseId)
      .sort((left, right) => left.generation - right.generation);

    expect(
      await readContainerLogEvents(fixture.clients.logs, {
        ...query,
        eventName: 'lease-failed',
      }),
    ).toEqual([]);
    expect(measured.map((event) => event.generation)).toEqual(
      Array.from({ length: renewals }, (_, index) => index + 1),
    );
    // An eventually-consistent read never once failed to see a just-written lease.
    expect(measured.map((event) => event.readBackPolls)).toEqual(
      Array.from({ length: renewals }, () => 1),
    );
    const [first, ...later] = measured;
    expect(first?.writeLatencyMilliseconds).toBeLessThan(
      firstWriteWithinMilliseconds,
    );
    expect(first?.visibleAfterMilliseconds).toBeLessThan(
      firstWriteWithinMilliseconds,
    );
    for (const renewal of later) {
      expect(renewal.writeLatencyMilliseconds).toBeLessThan(
        writeWithinMilliseconds,
      );
      expect(renewal.visibleAfterMilliseconds).not.toBeNull();
      expect(renewal.visibleAfterMilliseconds).toBeLessThan(
        visibleWithinMilliseconds,
      );
    }

    // The task finished cleanly — a lease write that failed would fail it.
    const finalState = await vi.waitUntil(
      async () => {
        const { state } = taskFrom(
          await a2a.GetTask(session, task.id),
          'GetTask',
        ).status;
        return state === 'TASK_STATE_SUBMITTED' ? false : state;
      },
      { timeout: runMilliseconds + 30_000, interval: 1_000 },
    );
    expect(finalState).toBe('TASK_STATE_COMPLETED');
    // And the item holds the last generation, written by that container.
    const item = await fixture.clients.dynamo.send(
      new GetItemCommand({
        TableName: leaseTableName,
        Key: { leaseId: { S: leaseId } },
      }),
    );
    expect(item.Item?.generation?.N).toBe(String(renewals));
    expect(item.Item?.containerId?.S).toBe(task.metadata.containerId);
  }, 240_000);
});
