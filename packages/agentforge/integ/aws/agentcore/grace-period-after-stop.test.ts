/**
 * §C — is the post-SIGTERM grace period a fixed window, or does AgentCore kill
 * the container once it stops reporting HealthyBusy?
 *
 * The first run could not tell them apart: a 60 s task was stopped and the
 * container died 56 s after SIGTERM, which is both "about a minute" and "about
 * when the task finished". So two sessions are stopped at the same moment, one
 * holding a SHORT task and one a LONG one. A fixed window kills both at the
 * same offset; an idle-triggered kill follows each task.
 *
 * Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md): the
 * 4 s task's container survived 62.6 s after SIGTERM, idle; the 240 s task's
 * survived 61.0 s, still busy. Across three observations 56.0, 61.0 and
 * 62.6 s: a nominal 60 seconds plus jitter, not tied to the workload.
 * Finishing early does not release the container, and being busy — `/ping`
 * answering HealthyBusy — does not extend it.
 *
 * The container deliberately does NOT exit on SIGTERM; it logs a heartbeat
 * every 500 ms, so the moment it is killed is the last beat. The heartbeat
 * stops itself at 180 s, so a container the platform never killed shows as
 * one that outlived the window.
 */
import { setTimeout } from 'node:timers/promises';
import { StopRuntimeSessionCommand } from '@aws-sdk/client-bedrock-agentcore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import type { ContainerLogEventNamed } from './__fixtures__/container-log-events.ts';
import { A2aOverAgentCore } from './__fixtures__/invocation.ts';
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

/** 56.0–62.6 s observed: a nominal 60 s and a few seconds of jitter. */
const graceWindow = { atLeastMilliseconds: 50_000, atMostMilliseconds: 75_000 };
/** Both observed windows within 1.6 s of each other. */
const sameOffsetWithinMilliseconds = 10_000;
/** Read once both containers must be dead if the window holds, with time for CloudWatch to ingest. */
const readHeartbeatsAfterStopMilliseconds = 130_000;
const logClockMarginMilliseconds = 60_000;

describe('the grace period after StopRuntimeSession (§C)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'grace',
      profile: a2aOneZeroOnlyProfile,
      outcomeTable: false,
    });
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'grace-period-after-stop'),
    teardownTimeoutMilliseconds,
  );

  it('kills a stopped container about 60 seconds after SIGTERM, whether its task finished long before or is still running', async () => {
    const [short, long] = await Promise.all(
      [
        { label: 'short', runMilliseconds: 4_000 },
        { label: 'long', runMilliseconds: 240_000 },
      ].map(async ({ label, runMilliseconds }) => {
        const session = newRuntimeSessionId(`grace-${label}`);
        const { task } = await a2a.SendMessage(session, { runMilliseconds });
        return { session, containerId: task.metadata.containerId };
      }),
    );
    if (short === undefined || long === undefined) {
      throw new Error('expected two running sessions');
    }
    expect(short.containerId).not.toBe(long.containerId);

    await setTimeout(2_000);
    const stopIssuedAt = Date.now();
    const stops = await Promise.all(
      [short, long].map(({ session }) =>
        fixture.clients.data.send(
          new StopRuntimeSessionCommand({
            agentRuntimeArn: fixture.runtime.agentRuntimeArn,
            runtimeSessionId: session,
          }),
        ),
      ),
    );
    for (const stopped of stops) {
      expect(stopped.$metadata.httpStatusCode).toBe(200);
    }

    await setTimeout(
      Math.max(
        0,
        stopIssuedAt + readHeartbeatsAfterStopMilliseconds - Date.now(),
      ),
    );
    const lastBeatOf = async (
      containerId: string,
    ): Promise<ContainerLogEventNamed<'post-sigterm'>> => {
      const beats = await waitForContainerLogEvents(
        fixture.clients.logs,
        {
          agentRuntimeId: fixture.runtime.agentRuntimeId,
          eventName: 'post-sigterm',
          containerId,
          startTime: stopIssuedAt - logClockMarginMilliseconds,
        },
        (events) => events.length > 0,
        60_000,
      );
      return beats.reduce((latest, beat) =>
        beat.millisecondsSinceSigterm > latest.millisecondsSinceSigterm
          ? beat
          : latest,
      );
    };
    const shortLastBeat = await lastBeatOf(short.containerId);
    const longLastBeat = await lastBeatOf(long.containerId);

    for (const lastBeat of [shortLastBeat, longLastBeat]) {
      expect(lastBeat.millisecondsSinceSigterm).toBeGreaterThanOrEqual(
        graceWindow.atLeastMilliseconds,
      );
      expect(lastBeat.millisecondsSinceSigterm).toBeLessThanOrEqual(
        graceWindow.atMostMilliseconds,
      );
    }
    // Finishing early did not release it: idle for most of a minute.
    expect(shortLastBeat.liveTasks).toBe(0);
    // Being busy did not extend it: killed with its task still live.
    expect(longLastBeat.liveTasks).toBe(1);
    // The window is fixed, not tied to the workload.
    expect(
      Math.abs(
        shortLastBeat.millisecondsSinceSigterm -
          longLastBeat.millisecondsSinceSigterm,
      ),
    ).toBeLessThan(sameOffsetWithinMilliseconds);
  }, 360_000);
});
