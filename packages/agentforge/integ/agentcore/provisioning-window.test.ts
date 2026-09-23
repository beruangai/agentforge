/**
 * §B — the provisioning window: what a caller sees between `CreateAgentRuntime`
 * and the first invocation that works, and what deleting costs.
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
 * `DeleteAgentRuntime` returns at once while the runtime sits in DELETING for
 * about five minutes, so a teardown cannot be treated as synchronous.
 */
import { setTimeout } from 'node:timers/promises';
import {
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import {
  A2aOverAgentCore,
  type Invocation,
  sendMessageParams,
  taskFrom,
} from './__fixtures__/invocation.ts';
import {
  a2a10OnlyProfile,
  type CreatedAgentRuntime,
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

interface WindowObservation {
  /** Since `CreateAgentRuntime` returned, when the probe was issued. */
  readonly elapsedMilliseconds: number;
  readonly controlPlaneStatus: string;
  readonly invocation: Invocation;
}

describe('the AgentCore provisioning window (§B)', () => {
  const resources = createResourceStack();
  let prepared: PreparedFixtureImage;
  let runtime: CreatedAgentRuntime | undefined;

  beforeAll(async () => {
    prepared = await prepareFixtureImage(resources, 'window');
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'provisioning-window'),
    teardownTimeoutMilliseconds,
  );

  it('blocks an invocation issued while CREATING until it can be served — no 409 — on one container throughout', async () => {
    const created = await createAgentRuntime(resources, prepared, {
      profile: a2a10OnlyProfile,
    });
    runtime = created;
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
    const giveUpAt = created.createReturnedAt + 180_000;
    while (Date.now() < giveUpAt) {
      const elapsedMilliseconds = Date.now() - created.createReturnedAt;
      const { status } = await prepared.clients.control.send(
        new GetAgentRuntimeCommand({ agentRuntimeId: created.agentRuntimeId }),
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
    // READY in seconds, not minutes (~10 s measured).
    expect(readyAfterMilliseconds, summary).toBeDefined();
    expect(readyAfterMilliseconds).toBeLessThan(60_000);
    // One container served the session across CREATING → READY.
    const containers = observations.map(
      ({ invocation }) =>
        taskFrom(invocation, 'SendMessage').metadata.containerId,
    );
    expect(new Set(containers).size, summary).toBe(1);
    expect(
      observations.some(
        ({ controlPlaneStatus }) => controlPlaneStatus === 'READY',
      ),
    ).toBe(true);
  }, 300_000);

  it('returns from DeleteAgentRuntime while the runtime is still DELETING', async () => {
    if (runtime === undefined) {
      throw new Error('the provisioning window test created no runtime');
    }
    const { agentRuntimeId } = runtime;
    const deleted = await prepared.clients.control.send(
      new DeleteAgentRuntimeCommand({ agentRuntimeId }),
    );
    expect(deleted.status).toBe('DELETING');
    const after = await prepared.clients.control.send(
      new GetAgentRuntimeCommand({ agentRuntimeId }),
    );
    expect(after.status).toBe('DELETING');
    // The deferred teardown waits for it to be gone.
  });
});
