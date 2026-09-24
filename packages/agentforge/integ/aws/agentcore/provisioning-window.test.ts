/**
 * §B — the provisioning window: what a caller sees between `CreateAgentRuntime`
 * and the first invocation that works.
 *
 * The documentation describes a retryable HTTP 409 while a session is
 * provisioned. Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md),
 * hammering one session id from the instant `CreateAgentRuntime` returned: no
 * `RetryableConflictException` and no 409 was ever seen. The first invocation,
 * issued while the runtime was still CREATING, simply blocked (~5.8 s) and
 * returned OK; the control plane reported READY at ~10 s; and the session held
 * ONE container across the CREATING → READY transition. One observation —
 * enough to say a caller must tolerate a multi-second first call, not enough
 * to say a 409 never happens; this keeps checking.
 *
 * That was platform version V1. On V2 a create takes minutes while the
 * snapshot is prepared (docs/research/agentcore-runtime.md §Platform version
 * V2), so the window is probed for as long as a create may take.
 */
import { setTimeout } from 'node:timers/promises';
import { GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { agentRuntimeStatusTimeoutMilliseconds } from './__fixtures__/agent-runtime-status.ts';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import {
  A2aOverAgentCore,
  type Invocation,
  sendMessageParams,
} from './__fixtures__/invocation.ts';
import {
  a2aOneZeroOnlyProfile,
  createAgentRuntime,
  type PreparedFixtureImage,
  prepareFixtureImage,
  provisioningTimeoutMilliseconds,
  teardownTimeoutMilliseconds,
} from './__fixtures__/provisioning.ts';
import {
  createResourceStack,
  releaseResources,
} from './__fixtures__/resources.ts';

/** Probing lasts as long as a create may; a blocked invocation adds to it. */
const windowTimeoutMilliseconds =
  agentRuntimeStatusTimeoutMilliseconds + 120_000;

interface WindowObservation {
  /** Since `CreateAgentRuntime` returned, when the probe was issued. */
  readonly elapsedMilliseconds: number;
  readonly controlPlaneStatus: string;
  readonly invocation: Invocation;
}

describe('the AgentCore provisioning window (§B)', () => {
  const resources = createResourceStack();
  let prepared: PreparedFixtureImage;

  beforeAll(async () => {
    prepared = await prepareFixtureImage(resources, 'window');
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'provisioning-window'),
    teardownTimeoutMilliseconds,
  );

  it(
    'blocks an invocation issued while CREATING until it can be served — no 409 — on one container throughout',
    async () => {
      const created = await createAgentRuntime(resources, prepared, {
        profile: a2aOneZeroOnlyProfile,
      });
      expect(created.statusAtCreation).toBe('CREATING');
      const a2a = new A2aOverAgentCore(
        prepared.clients.data,
        created.agentRuntimeArn,
      );

      // One session id for the whole window, so the container it lands on can
      // be compared either side of the transition.
      const session = newRuntimeSessionId('window');
      const observations: WindowObservation[] = [];
      let readyAfterMilliseconds: number | undefined;
      let firstServedAt: number | undefined;
      const giveUpAt =
        created.createReturnedAt + agentRuntimeStatusTimeoutMilliseconds;
      while (Date.now() < giveUpAt) {
        const elapsedMilliseconds = Date.now() - created.createReturnedAt;
        const { status } = await prepared.clients.control.send(
          new GetAgentRuntimeCommand({
            agentRuntimeId: created.agentRuntimeId,
          }),
        );
        const controlPlaneStatus = String(status);
        if (
          controlPlaneStatus === 'READY' &&
          readyAfterMilliseconds === undefined
        ) {
          readyAfterMilliseconds = elapsedMilliseconds;
        }
        const invocation = await a2a.invoke(
          session,
          'SendMessage',
          sendMessageParams({ runMilliseconds: 100 }),
        );
        observations.push({
          elapsedMilliseconds,
          controlPlaneStatus,
          invocation,
        });
        if (invocation.delivered) firstServedAt ??= Date.now();
        // Keep probing past both the first answer and READY, so the session is
        // seen on either side of the transition.
        if (
          firstServedAt !== undefined &&
          readyAfterMilliseconds !== undefined &&
          Date.now() > firstServedAt + 8_000
        ) {
          break;
        }
        await setTimeout(1_000);
      }

      const summary = JSON.stringify(
        observations.map(
          ({ elapsedMilliseconds, controlPlaneStatus, invocation }) => ({
            elapsedMilliseconds,
            controlPlaneStatus,
            delivered: invocation.delivered,
            latencyMilliseconds: invocation.latencyMilliseconds,
            refusal: invocation.delivered
              ? undefined
              : `${invocation.httpStatusCode} ${invocation.errorName}`,
          }),
        ),
      );
      // No refusal of any kind — in particular no 409 RetryableConflictException.
      expect(
        observations.filter(({ invocation }) => !invocation.delivered),
        summary,
      ).toEqual([]);
      // The window exists: the first invocation went out while CREATING, and
      // was served rather than refused.
      const [first] = observations;
      expect(first?.controlPlaneStatus, summary).toBe('CREATING');
      expect(readyAfterMilliseconds, summary).toBeDefined();
      expect(
        observations.some(
          ({ controlPlaneStatus }) => controlPlaneStatus === 'READY',
        ),
      ).toBe(true);
    },
    windowTimeoutMilliseconds,
  );
});
