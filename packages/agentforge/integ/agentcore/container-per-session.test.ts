/**
 * §B — is a container started per runtime session, or drawn from a pool?
 *
 * Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md): six
 * brand-new session ids fired in parallel landed on six distinct containers,
 * and fired again three seconds later 6/6 returned the same container. At a
 * session's FIRST call its container had already been up for 28–212 seconds:
 * a session claims a pre-warmed container, it does not start one. And a
 * session's first call costs more than the ones after it (≈1.2 s against
 * ≈355 ms).
 *
 * On the first night eleven `listening` events appeared shortly after
 * `CreateAgentRuntime`, before any invocation, and were read as a pre-warmed
 * pool without being tested. This waits for that — containers listening before
 * anything has been invoked — and then asserts every new session lands on one
 * of them.
 */
import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const sessionCount = 6;
/** Allows for a skew between this machine's clock and CloudWatch's. */
const logClockMarginMilliseconds = 60_000;

describe('AgentCore runtime sessions and containers (§B)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'per_session',
      profile: a2a10OnlyProfile,
      leaseTable: false,
    });
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'container-per-session'),
    teardownTimeoutMilliseconds,
  );

  it('gives each new session a container that was already listening, and keeps the session on it', async () => {
    // The pool, observed before anything is invoked: one container for each
    // session and one for the client warm-up.
    const listening = await waitForContainerLogEvents(
      fixture.clients.logs,
      {
        agentRuntimeId: fixture.runtime.agentRuntimeId,
        eventName: 'listening',
        startTime: fixture.runtime.createIssuedAt - logClockMarginMilliseconds,
      },
      (events) =>
        new Set(events.map((event) => event.containerId)).size >=
        sessionCount + 1,
      300_000,
    );
    const prestarted = [
      ...new Set(listening.map((event) => event.containerId)),
    ];

    // Warm the client FIRST. Credential resolution, TLS and the SDK's lazy
    // module loading all land on whichever call is first: on the spike's first
    // run six parallel first calls each showed ~2.66 s, which was the client,
    // not the platform. So: warm up, discard, then measure.
    await a2a.SendMessage(newRuntimeSessionId('warmup'), {
      runMilliseconds: 200,
    });

    const sessions = Array.from({ length: sessionCount }, () =>
      newRuntimeSessionId('pool'),
    );
    const firstRound = await Promise.all(
      sessions.map((session) =>
        a2a.SendMessage(session, { runMilliseconds: 200 }),
      ),
    );
    await setTimeout(3_000);
    const secondRound = await Promise.all(
      sessions.map((session) =>
        a2a.SendMessage(session, { runMilliseconds: 200 }),
      ),
    );

    const firstContainers = firstRound.map(
      ({ task }) => task.metadata.containerId,
    );
    // One container per session — and every one was listening before any
    // session existed, running for longer than the call that claimed it.
    expect(new Set(firstContainers).size).toBe(sessionCount);
    for (const { invocation, task } of firstRound) {
      expect(prestarted).toContain(task.metadata.containerId);
      expect(task.metadata.containerUptimeMilliseconds).toBeGreaterThan(
        invocation.latencyMilliseconds,
      );
    }
    // Pinned: the same session reaches the same container, 6/6.
    expect(secondRound.map(({ task }) => task.metadata.containerId)).toEqual(
      firstContainers,
    );
    // Establishing a session costs something: first calls are slower in total.
    const totalLatency = (round: typeof firstRound) =>
      round.reduce(
        (total, { invocation }) => total + invocation.latencyMilliseconds,
        0,
      );
    expect(totalLatency(firstRound)).toBeGreaterThan(totalLatency(secondRound));
  }, 420_000);
});
