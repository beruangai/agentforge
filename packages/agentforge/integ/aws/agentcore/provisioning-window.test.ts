/**
 * research §B — the provisioning window: what a caller sees between `CreateAgentRuntime`
 * and the first invocation that works.
 *
 * The documentation describes a retryable HTTP 409 while a session is
 * provisioned. Neither platform version answers that way
 * (docs/research/agentcore-runtime-observed.md):
 *
 * - V1, 2026-09-22: an invocation issued while CREATING blocked ~5.8 s and was
 *   served; READY followed at ~10 s.
 * - V2, 2026-09-24: CREATING lasted ~3 minutes, and every invocation in it was
 *   refused at once with HTTP 400 and JSON-RPC `-32052` "Validation error -
 *   Invalid request data" — the shape of a caller's own mistake, not a
 *   retryable conflict. The first invocation after READY was still refused;
 *   the next, ~1.7 s later, was served.
 *
 * So nothing may route to a runtime before it is READY, and a refusal in the
 * window cannot be told from a bad request by its shape. This keeps checking
 * both, and how soon after READY the session is served.
 */
import { setTimeout } from 'node:timers/promises';
import { GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_RUNTIME_STATUS_TIMEOUT_MILLISECONDS } from './__fixtures__/agent-runtime-status.ts';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import {
  A2aOverAgentCore,
  type Invocation,
  sendMessageParams,
} from './__fixtures__/invocation.ts';
import {
  A2A_ONE_ZERO_ONLY_PROFILE,
  createAgentRuntime,
  PROVISIONING_TIMEOUT_MILLISECONDS,
  type PreparedFixtureImage,
  prepareFixtureImage,
  TEARDOWN_TIMEOUT_MILLISECONDS,
} from './__fixtures__/provisioning.ts';
import {
  createResourceStack,
  releaseResources,
} from './__fixtures__/resources.ts';

/** Probing lasts as long as a create may, and past READY until served. */
const WINDOW_TIMEOUT_MILLISECONDS =
  AGENT_RUNTIME_STATUS_TIMEOUT_MILLISECONDS + 120_000;
/** One refusal after READY was observed, the next probe ~1.7 s later served. */
const SERVED_WITHIN_MILLISECONDS_OF_READY = 30_000;
/** What V2 answered to every invocation while CREATING. */
const REFUSAL_WHILE_CREATING = { httpStatusCode: 400, jsonRpcCode: -32052 };

interface WindowObservation {
  /** Since `CreateAgentRuntime` returned, when the probe was issued. */
  readonly elapsedMilliseconds: number;
  readonly controlPlaneStatus: string;
  readonly invocation: Invocation;
}

describe('the AgentCore provisioning window (research §B)', () => {
  const resources = createResourceStack();
  let prepared: PreparedFixtureImage;

  beforeAll(async () => {
    prepared = await prepareFixtureImage(resources, 'window');
  }, PROVISIONING_TIMEOUT_MILLISECONDS);

  afterAll(
    () => releaseResources(resources, 'provisioning-window'),
    TEARDOWN_TIMEOUT_MILLISECONDS,
  );

  it(
    'refuses every invocation while CREATING as a bad request, not a retryable 409, and serves the session soon after READY',
    async () => {
      const created = await createAgentRuntime(resources, prepared, {
        profile: A2A_ONE_ZERO_ONLY_PROFILE,
      });
      expect(created.statusAtCreation).toBe('CREATING');
      const a2a = new A2aOverAgentCore(
        prepared.clients.data,
        created.agentRuntimeArn,
      );

      // One session id for the whole window, probed either side of READY.
      const session = newRuntimeSessionId('window');
      const observations: WindowObservation[] = [];
      let readyAfterMilliseconds: number | undefined;
      let firstServedAt: number | undefined;
      const giveUpAt =
        created.createReturnedAt + AGENT_RUNTIME_STATUS_TIMEOUT_MILLISECONDS;
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
              : `${invocation.httpStatusCode} ${invocation.jsonRpcError?.code ?? invocation.errorName}`,
          }),
        ),
      );
      const [first] = observations;
      expect(first?.controlPlaneStatus, summary).toBe('CREATING');
      // While CREATING, nothing is served, and the refusal is not the
      // documented retryable 409.
      const whileCreating = observations.filter(
        ({ controlPlaneStatus }) => controlPlaneStatus === 'CREATING',
      );
      for (const { invocation } of whileCreating) {
        expect(invocation.delivered, summary).toBe(false);
        if (invocation.delivered) continue;
        expect(invocation.httpStatusCode, summary).toBe(
          REFUSAL_WHILE_CREATING.httpStatusCode,
        );
        expect(invocation.jsonRpcError?.code, summary).toBe(
          REFUSAL_WHILE_CREATING.jsonRpcCode,
        );
      }
      // Once READY, the session is served soon, and stays served.
      expect(readyAfterMilliseconds, summary).toBeDefined();
      const firstServed = observations.findIndex(
        ({ invocation }) => invocation.delivered,
      );
      const served = observations[firstServed];
      if (served === undefined || readyAfterMilliseconds === undefined) {
        throw new Error(`the session was never served: ${summary}`);
      }
      expect(served.elapsedMilliseconds, summary).toBeLessThanOrEqual(
        readyAfterMilliseconds + SERVED_WITHIN_MILLISECONDS_OF_READY,
      );
      expect(
        observations
          .slice(firstServed)
          .filter(({ invocation }) => !invocation.delivered),
        summary,
      ).toEqual([]);
    },
    WINDOW_TIMEOUT_MILLISECONDS,
  );
});
