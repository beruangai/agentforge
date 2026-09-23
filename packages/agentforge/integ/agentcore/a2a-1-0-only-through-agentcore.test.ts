/**
 * §I, end to end on the real platform — A2A 1.0 only, AgentForge's own
 * configuration (ADR 0014): the card declares one interface at 1.0,
 * `legacyCompat` is off, and the runtime allowlists `A2A-Version`.
 *
 * Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md): a
 * strict 1.0 runtime answered `A2A-Version: 1.0` + `SendMessage` with 1.0
 * negotiated, and refused the same call without the header. That refusal is
 * the one cost of strict 1.0: the container answers `-32009` "version '0.3'
 * is not supported", but AgentCore wraps any non-2xx container response, so
 * the caller sees HTTP 424 `-32055 "Runtime client error"` — the same opaque
 * error as a crash or a bad content type. Which is why the client asserts the
 * negotiated version rather than inferring success from a 200.
 *
 * And `GetAgentCard` returns the container's own card, not a synthesised one —
 * with `url` and every `supportedInterfaces[].url` rewritten to the runtime's
 * invocation endpoint, so the container need not, and must not be relied on
 * to, declare its own public URL.
 */
import { GetAgentCardCommand } from '@aws-sdk/client-bedrock-agentcore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildFixtureAgentCard } from '../__fixtures__/agent-card.ts';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import type { ContainerLogEventNamed } from './__fixtures__/container-log-events.ts';
import {
  A2aOverAgentCore,
  invokeJsonRpc,
  sendMessageParams,
} from './__fixtures__/invocation.ts';
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

const logClockMarginMilliseconds = 60_000;

describe('A2A 1.0 only, through AgentCore (ADR 0014)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let a2a: A2aOverAgentCore;
  let startedAt: number;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'a2a_1_0_only',
      profile: a2a10OnlyProfile,
      leaseTable: false,
    });
    a2a = new A2aOverAgentCore(
      fixture.clients.data,
      fixture.runtime.agentRuntimeArn,
    );
    startedAt = Date.now();
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'a2a-1-0-only-through-agentcore'),
    teardownTimeoutMilliseconds,
  );

  async function requestSeenBy(
    runtimeSessionId: string,
  ): Promise<ContainerLogEventNamed<'request'>> {
    const events = await waitForContainerLogEvents(
      fixture.clients.logs,
      {
        agentRuntimeId: fixture.runtime.agentRuntimeId,
        eventName: 'request',
        startTime: startedAt - logClockMarginMilliseconds,
      },
      (read) =>
        read.some((event) => event.runtimeSessionId === runtimeSessionId),
      180_000,
    );
    const requests = events.filter(
      (event) => event.runtimeSessionId === runtimeSessionId,
    );
    const [request] = requests;
    if (requests.length !== 1 || request === undefined) {
      throw new Error(
        `expected one request for ${runtimeSessionId}, the container logged ${requests.length}`,
      );
    }
    return request;
  }

  it('negotiates 1.0 when the allowlisted A2A-Version: 1.0 accompanies SendMessage', async () => {
    const session = newRuntimeSessionId('strict');
    const { task } = await a2a.SendMessage(session, { runMilliseconds: 200 });
    expect(task.metadata.negotiatedVersion).toBe('1.0');
    expect(await requestSeenBy(session)).toMatchObject({
      a2aVersion: '1.0',
      jsonRpcMethod: 'SendMessage',
    });
  }, 240_000);

  it('refuses the same call without the header, and the caller sees only an opaque 424', async () => {
    const session = newRuntimeSessionId('strict-no-header');
    const invocation = await invokeJsonRpc(fixture.clients.data, {
      agentRuntimeArn: fixture.runtime.agentRuntimeArn,
      runtimeSessionId: session,
      method: 'SendMessage',
      params: sendMessageParams({ runMilliseconds: 200 }),
    });
    expect(invocation).toMatchObject({
      delivered: false,
      httpStatusCode: 424,
      jsonRpcError: {
        code: -32055,
        message: expect.stringMatching(/^Runtime client error/),
      },
    });
    // It reached the container, which refused it — the platform did not.
    expect(await requestSeenBy(session)).toMatchObject({
      a2aVersion: null,
      jsonRpcMethod: 'SendMessage',
    });
  }, 240_000);

  it("serves the container's own card through GetAgentCard, verbatim but for its URLs", async () => {
    const { agentCard } = await fixture.clients.data.send(
      new GetAgentCardCommand({
        agentRuntimeArn: fixture.runtime.agentRuntimeArn,
      }),
    );
    const invocationEndpoint = `https://bedrock-agentcore.${fixture.environment.region}.amazonaws.com/runtimes/${encodeURIComponent(fixture.runtime.agentRuntimeArn)}/invocations`;
    // As the container serves it — JSON, so `undefined` fields are absent —
    // with every URL pointing at the invocation endpoint.
    const expected: unknown = JSON.parse(
      JSON.stringify(
        buildFixtureAgentCard({ url: invocationEndpoint, strict10: true }),
      ),
    );
    expect(agentCard).toEqual(expected);
  });
});
