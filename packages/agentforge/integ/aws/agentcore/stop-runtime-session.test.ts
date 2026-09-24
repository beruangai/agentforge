/**
 * §C, platform half — what `StopRuntimeSession` does to a container that is
 * mid-task.
 *
 * `ARCHITECTURE.md` treats cancellation as cooperative: the task process is
 * asked to stop and given a grace period. Whether the platform offers the same
 * courtesy — a SIGTERM, then time — decides whether a cancelled run keeps its
 * side-effect recovery. Measured on 2026-09-22
 * (docs/research/agentcore-runtime-observed.md): the stop returns HTTP 200 in
 * ~390 ms, the container receives a real SIGTERM ~400 ms later with the task
 * still live, and the next invocation on the same session id lands on a FRESH
 * container with an empty task store — `GetTask` for the stopped task answers
 * "Task not found" for as long as it was polled (25 s).
 *
 * So a stop is not a cancel: the session no longer points at the process doing
 * the work, and anything that must survive a stop has to be outside the
 * container before the stop lands.
 */
import { setTimeout } from 'node:timers/promises';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import {
  A2aOverAgentCore,
  delivered,
  taskFrom,
} from './__fixtures__/invocation.ts';
import {
  a2aOneZeroOnlyProfile,
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

/** Prompt, not deferred to the end of the grace period (~400 ms measured). */
const sigtermWithinMillisecondsOfTheStop = 5_000;
const logClockMarginMilliseconds = 60_000;

describe('StopRuntimeSession against a container that is mid-task (§C)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'stop',
      profile: a2aOneZeroOnlyProfile,
      outcomeTable: false,
    });
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'stop-runtime-session'),
    teardownTimeoutMilliseconds,
  );

  it('SIGTERMs the busy container at once, and the session then reaches a fresh container that never knew the task', async () => {
    // Warm the client so the measured calls do not carry SDK start-up.
    await a2a.SendMessage(newRuntimeSessionId('warm'), {
      runMilliseconds: 100,
    });

    const session = newRuntimeSessionId('stop');
    const started = await a2a.SendMessage(session, { runMilliseconds: 60_000 });
    const victim = started.task.metadata.containerId;
    // The container's clock relative to this one, NTP-style from one round
    // trip, and how far that estimate can be off.
    const containerClockOffset =
      started.task.metadata.containerNow -
      (started.invocation.startedAt +
        started.invocation.latencyMilliseconds / 2);
    const offsetUncertainty = started.invocation.latencyMilliseconds / 2;

    await setTimeout(2_000);
    expect(
      taskFrom(await a2a.GetTask(session, started.task.id), 'GetTask').status
        .state,
    ).toBe('TASK_STATE_SUBMITTED');

    const stopIssuedAt = Date.now();
    const stopped = await fixture.clients.data.send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn: fixture.runtime.agentRuntimeArn,
        runtimeSessionId: session,
      }),
    );
    const stopReturnedAt = Date.now();
    expect(stopped.$metadata.httpStatusCode).toBe(200);

    // The stopped task is unreachable from the moment the stop returns: every
    // poll is answered, and every answer is "Task not found".
    const pollsUntil = Date.now() + 20_000;
    let polls = 0;
    while (Date.now() < pollsUntil) {
      const polled = delivered(
        await a2a.GetTask(session, started.task.id),
        'GetTask',
      );
      expect(polled.body.error?.message).toMatch(/^Task not found/);
      polls += 1;
      await setTimeout(1_500);
    }
    expect(polls).toBeGreaterThan(5);

    // The session now routes to a different container.
    const next = await a2a.SendMessage(session, { runMilliseconds: 100 });
    expect(next.task.metadata.containerId).not.toBe(victim);

    // The victim got a real SIGTERM, promptly, with its task still live.
    const [sigterm] = await waitForContainerLogEvents(
      fixture.clients.logs,
      {
        agentRuntimeId: fixture.runtime.agentRuntimeId,
        eventName: 'sigterm',
        containerId: victim,
        startTime: stopIssuedAt - logClockMarginMilliseconds,
      },
      (events) => events.length > 0,
      120_000,
    );
    if (sigterm === undefined) {
      throw new Error('waitForContainerLogEvents returned no sigterm event');
    }
    expect(sigterm.liveTasks).toBe(1);
    const sigtermOnThisClock = sigterm.at - containerClockOffset;
    expect(sigtermOnThisClock).toBeGreaterThan(
      stopIssuedAt - offsetUncertainty,
    );
    expect(sigtermOnThisClock).toBeLessThan(
      stopReturnedAt + sigtermWithinMillisecondsOfTheStop + offsetUncertainty,
    );
  }, 240_000);
});
