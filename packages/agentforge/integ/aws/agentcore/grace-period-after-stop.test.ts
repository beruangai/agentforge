/**
 * research §C — is the post-SIGTERM grace period a fixed window, or does AgentCore kill
 * the container once it stops reporting HealthyBusy?
 *
 * The first run could not tell them apart: a 60 s task was stopped and the
 * container died 56 s after SIGTERM, which is both "about a minute" and "about
 * when the task finished". So two sessions are stopped at the same moment, one
 * holding a SHORT task and one a LONG one. A fixed window kills both at the
 * same offset; an idle-triggered kill follows each task.
 *
 * Measured on platform version V1, 2026-09-22: a nominal 60 s — 56.0, 61.0
 * and 62.6 s across three observations. On V2, 2026-09-24, twice: the idle
 * container died 9.5 s after SIGTERM and the busy one 10.0 s after
 * (docs/research/agentcore-runtime-observed.md). A fixed window either way —
 * finishing early does not release the container, and being busy — `/ping`
 * answering HealthyBusy — does not extend it — but on V2 it is about ten
 * seconds, inside the 15 s the documentation gives an idle or lifetime
 * termination.
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

/** 9.5–10.0 s observed on V2; the documentation's 15 s for other terminations, with margin. */
const GRACE_WINDOW = { atLeastMilliseconds: 7_000, atMostMilliseconds: 20_000 };
/** Both V2 windows within 0.5 s of each other. */
const SAME_OFFSET_WITHIN_MILLISECONDS = 3_000;
/**
 * Read once both containers must be dead, with time for CloudWatch to ingest —
 * long enough that a return to V1's ~60 s shows as a failure, not a timeout.
 */
const READ_HEARTBEATS_AFTER_STOP_MILLISECONDS = 130_000;
const LOG_CLOCK_MARGIN_MILLISECONDS = 60_000;

describe('the grace period after StopRuntimeSession (research §C)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'grace',
      profile: A2A_ONE_ZERO_ONLY_PROFILE,
      outcomeTable: false,
    });
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
  }, PROVISIONING_TIMEOUT_MILLISECONDS);

  afterAll(
    () => releaseResources(resources, 'grace-period-after-stop'),
    TEARDOWN_TIMEOUT_MILLISECONDS,
  );

  it('kills a stopped container about ten seconds after SIGTERM, whether its task finished long before or is still running', async () => {
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
        stopIssuedAt + READ_HEARTBEATS_AFTER_STOP_MILLISECONDS - Date.now(),
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
          startTime: stopIssuedAt - LOG_CLOCK_MARGIN_MILLISECONDS,
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

    const summary = JSON.stringify({
      short: shortLastBeat,
      long: longLastBeat,
    });
    for (const lastBeat of [shortLastBeat, longLastBeat]) {
      expect(lastBeat.millisecondsSinceSigterm, summary).toBeGreaterThanOrEqual(
        GRACE_WINDOW.atLeastMilliseconds,
      );
      expect(lastBeat.millisecondsSinceSigterm, summary).toBeLessThanOrEqual(
        GRACE_WINDOW.atMostMilliseconds,
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
    ).toBeLessThan(SAME_OFFSET_WITHIN_MILLISECONDS);
  }, 360_000);
});
