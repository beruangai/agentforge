/**
 * §B — a busy container still receives invocations.
 *
 * `ARCHITECTURE.md` §4 asserts that `/ping` is a lifecycle signal rather than
 * admission control, so a container receives a start, a poll or a cancel
 * whatever it last reported. That began as inference from the contract's
 * silence, and the whole await path rests on it. Measured on 2026-09-22: with a
 * 25-second task live and `/ping` answering `HealthyBusy`, a second
 * `SendMessage`, a `GetTask` and a `CancelTask` were all delivered, 3/3, at
 * idle latency, and the two tasks ran concurrently in one container
 * (docs/research/agentcore-runtime-observed.md).
 *
 * The container mints a container id on its first invocation and returns it
 * on every task, so "the same container" is observed rather than assumed.
 * `GetTask` and `CancelTask` are answered from that container's in-memory task
 * store, so an answer naming the task proves the call reached the container
 * holding it. That a session stays on one microVM is AgentCore's documented
 * guarantee, and is not re-tested (docs/research/agentcore-runtime.md
 * §Sessions).
 */
import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import {
  A2aOverAgentCore,
  delivered,
  taskFrom,
} from './__fixtures__/invocation.ts';
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

/** A call held behind the 25-second task would take tens of seconds. */
const DELIVERED_WHILE_BUSY_WITHIN_MILLISECONDS = 5_000;

describe('a busy AgentCore container (§B)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'busy',
      profile: A2A_ONE_ZERO_ONLY_PROFILE,
      outcomeTable: false,
    });
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
  }, PROVISIONING_TIMEOUT_MILLISECONDS);

  afterAll(
    () => releaseResources(resources, 'busy-container-receives-invocations'),
    TEARDOWN_TIMEOUT_MILLISECONDS,
  );

  it('delivers SendMessage, GetTask and CancelTask to a session whose container is running a task', async () => {
    const session = newRuntimeSessionId('busy');
    const long = await a2a.SendMessage(session, { runMilliseconds: 25_000 });
    const container = long.task.metadata.containerId;
    expect(long.task.metadata.liveTasks).toBe(1);

    // Time for AgentCore's health check to see HealthyBusy before the calls
    // below; this container cannot observe the check itself.
    await setTimeout(1_500);

    // Fired together: if HealthyBusy were admission control, these would stall
    // behind the long task or be refused.
    const [second, polled] = await Promise.all([
      a2a.SendMessage(session, { runMilliseconds: 1_500 }),
      a2a.GetTask(session, long.task.id),
    ]);
    // Only after the poll has answered, with the long task still running. A
    // cancel fired on an 800 ms timer instead could land before the poll: on
    // 2026-09-24 the poll saw TASK_STATE_CANCELED.
    const cancelled = await a2a.CancelTask(session, long.task.id);

    // The second task ran concurrently, in the same container.
    expect(second.task.metadata.containerId).toBe(container);
    expect(second.task.metadata.liveTasks).toBe(2);
    expect(taskFrom(polled, 'GetTask')).toMatchObject({
      id: long.task.id,
      status: { state: 'TASK_STATE_SUBMITTED' },
    });
    expect(taskFrom(cancelled, 'CancelTask')).toMatchObject({
      id: long.task.id,
      status: { state: 'TASK_STATE_CANCELED' },
    });
    for (const invocation of [
      second.invocation,
      delivered(polled, 'GetTask'),
      delivered(cancelled, 'CancelTask'),
    ]) {
      expect(invocation.latencyMilliseconds).toBeLessThan(
        DELIVERED_WHILE_BUSY_WITHIN_MILLISECONDS,
      );
    }
  });
});
