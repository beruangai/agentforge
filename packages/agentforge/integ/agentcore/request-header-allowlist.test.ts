/**
 * §I — which request headers reach the container through `InvokeAgentRuntime`.
 *
 * An earlier run recorded that `A2A-Version` is never forwarded and concluded
 * AgentForge was pinned to protocol 0.3. That was the DEFAULT behaviour stated
 * as the platform's. AgentCore forwards any header on a per-runtime allowlist
 * (`requestHeaderConfiguration.requestHeaderAllowlist`), and `A2A-Version`
 * breaks none of its restrictions. Measured on 2026-09-22
 * (docs/research/agentcore-runtime-observed.md), with `A2A-Version` and
 * `X-Agentforge-Probe` allowlisted on a runtime that declares 1.0 AND 0.3:
 *
 *   | Sent                 | Reached the container | SDK negotiated |
 *   | nothing              | —                     | 0.3            |
 *   | A2A-Version: 0.3     | yes                   | 0.3            |
 *   | A2A-Version: 1.0     | yes                   | 1.0            |
 *   | X-Agentforge-Probe   | yes                   | 0.3            |
 *   | X-Not-Allowlisted    | no — dropped          | 0.3            |
 *
 * and by default exactly x-amzn-requestid, baggage, content-length, host,
 * x-amzn-bedrock-agentcore-runtime-session-id and x-amzn-trace-id arrive, plus
 * content-type and accept, which are `InvokeAgentRuntime`'s own parameters.
 *
 * Correction recorded the same night: `InvokeAgentRuntime` does NOT strip
 * `content-type`. It forwards the caller's unchanged and sends none when the
 * caller sent none (the AWS CLI). This SDK defaults to
 * `application/octet-stream`, which the A2A handler refuses — and AgentCore
 * reports that as HTTP 424 `-32055 "Runtime client error"`, naming neither the
 * header nor the cause.
 *
 * This runtime is the permissive one the table was measured on; AgentForge's
 * own 1.0-only configuration is asserted in a2a-1-0-only-through-agentcore.
 */
import { randomUUIDv7 } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newRuntimeSessionId } from './__fixtures__/aws-environment.ts';
import type { ContainerLogEventNamed } from './__fixtures__/container-log-events.ts';
import {
  type Invocation,
  invokeJsonRpc,
  taskFrom,
} from './__fixtures__/invocation.ts';
import {
  type FixtureRuntime,
  permissiveProbeHeadersProfile,
  provisionFixtureRuntime,
  provisioningTimeoutMilliseconds,
  teardownTimeoutMilliseconds,
} from './__fixtures__/provisioning.ts';
import {
  createResourceStack,
  releaseResources,
} from './__fixtures__/resources.ts';
import { waitForContainerLogEvents } from './__fixtures__/runtime-logs.ts';

/** What reaches the container when the caller adds nothing. */
const defaultHeaderNames = [
  'accept',
  'baggage',
  'content-length',
  'content-type',
  'host',
  'x-amzn-bedrock-agentcore-runtime-session-id',
  'x-amzn-requestid',
  'x-amzn-trace-id',
];
const logClockMarginMilliseconds = 60_000;

/**
 * The 0.3 method name and wire shape, deliberately: with no `A2A-Version` this
 * runtime negotiates 0.3, and `message/send` with `{ kind: 'data', data }` is
 * accepted under 0.3 and 1.0 alike.
 */
function messageSendParams(): unknown {
  return {
    message: {
      kind: 'message',
      messageId: randomUUIDv7(),
      role: 'user',
      contextId: randomUUIDv7(),
      parts: [{ kind: 'data', data: { runMilliseconds: 200 } }],
    },
    configuration: { blocking: false },
  };
}

function requestOf(
  seen: ReadonlyMap<string, ContainerLogEventNamed<'request'>>,
  runtimeSessionId: string,
): ContainerLogEventNamed<'request'> {
  const request = seen.get(runtimeSessionId);
  if (request === undefined) {
    throw new Error(`no request reached the container for ${runtimeSessionId}`);
  }
  return request;
}

describe('the AgentCore request header allowlist (§I)', () => {
  const resources = createResourceStack();
  let fixture: FixtureRuntime;
  let startedAt: number;

  beforeAll(async () => {
    fixture = await provisionFixtureRuntime(resources, {
      purpose: 'headers',
      profile: permissiveProbeHeadersProfile,
      leaseTable: false,
    });
    startedAt = Date.now();
  }, provisioningTimeoutMilliseconds);

  afterAll(
    () => releaseResources(resources, 'request-header-allowlist'),
    teardownTimeoutMilliseconds,
  );

  async function send(options: {
    headers?: Record<string, string>;
    contentType?: string | null;
  }): Promise<{ runtimeSessionId: string; invocation: Invocation }> {
    const runtimeSessionId = newRuntimeSessionId('headers');
    const invocation = await invokeJsonRpc(fixture.clients.data, {
      agentRuntimeArn: fixture.runtime.agentRuntimeArn,
      runtimeSessionId,
      method: 'message/send',
      params: messageSendParams(),
      headers: options.headers ?? {},
      contentType: options.contentType,
    });
    return { runtimeSessionId, invocation };
  }

  /** The request each session's container logged, one per session. */
  async function requestsSeenBy(
    runtimeSessionIds: readonly string[],
  ): Promise<Map<string, ContainerLogEventNamed<'request'>>> {
    const posts = (events: ContainerLogEventNamed<'request'>[]) =>
      events.filter(
        (event) =>
          event.method === 'POST' &&
          event.runtimeSessionId !== null &&
          runtimeSessionIds.includes(event.runtimeSessionId),
      );
    const events = await waitForContainerLogEvents(
      fixture.clients.logs,
      {
        agentRuntimeId: fixture.runtime.agentRuntimeId,
        eventName: 'request',
        startTime: startedAt - logClockMarginMilliseconds,
      },
      (read) =>
        runtimeSessionIds.every((id) =>
          posts(read).some((event) => event.runtimeSessionId === id),
        ),
      180_000,
    );
    const seen = new Map<string, ContainerLogEventNamed<'request'>>();
    for (const event of posts(events)) {
      if (event.runtimeSessionId === null) continue;
      if (seen.has(event.runtimeSessionId)) {
        throw new Error(
          `session ${event.runtimeSessionId} reached the container more than once`,
        );
      }
      seen.set(event.runtimeSessionId, event);
    }
    return seen;
  }

  it('forwards exactly the default headers plus what the allowlist names, and an allowlisted A2A-Version drives negotiation', async () => {
    const cases: {
      sent: string;
      headers: Record<string, string>;
      /** Header names beyond the defaults that reach the container. */
      reaches: string[];
      a2aVersion: string | null;
      negotiated: string;
    }[] = [
      {
        sent: 'nothing',
        headers: {},
        reaches: [],
        a2aVersion: null,
        negotiated: '0.3',
      },
      {
        sent: 'A2A-Version: 0.3',
        headers: { 'A2A-Version': '0.3' },
        reaches: ['a2a-version'],
        a2aVersion: '0.3',
        negotiated: '0.3',
      },
      {
        sent: 'A2A-Version: 1.0',
        headers: { 'A2A-Version': '1.0' },
        reaches: ['a2a-version'],
        a2aVersion: '1.0',
        negotiated: '1.0',
      },
      {
        sent: 'X-Agentforge-Probe (allowlisted)',
        headers: { 'X-Agentforge-Probe': 'probe' },
        reaches: ['x-agentforge-probe'],
        a2aVersion: null,
        negotiated: '0.3',
      },
      {
        sent: 'X-Not-Allowlisted',
        headers: { 'X-Not-Allowlisted': 'dropped' },
        reaches: [],
        a2aVersion: null,
        negotiated: '0.3',
      },
    ];
    const results = [];
    for (const testCase of cases) {
      results.push({
        ...testCase,
        ...(await send({ headers: testCase.headers })),
      });
    }
    const seen = await requestsSeenBy(
      results.map(({ runtimeSessionId }) => runtimeSessionId),
    );

    for (const result of results) {
      const request = requestOf(seen, result.runtimeSessionId);
      expect([...request.headerNames].sort(), result.sent).toEqual(
        [...defaultHeaderNames, ...result.reaches].sort(),
      );
      expect(request.a2aVersion, result.sent).toBe(result.a2aVersion);
      expect(request.contentType, result.sent).toBe('application/json');
      expect(
        taskFrom(result.invocation, 'message/send').metadata.negotiatedVersion,
        result.sent,
      ).toBe(result.negotiated);
    }
  }, 300_000);

  it("forwards the caller's content type unchanged — none when none was sent — and reports the A2A handler refusing one as an opaque 424", async () => {
    const octetStream = await send({ contentType: 'application/octet-stream' });
    const none = await send({ contentType: null });
    const seen = await requestsSeenBy([
      octetStream.runtimeSessionId,
      none.runtimeSessionId,
    ]);

    // Forwarded unchanged, and refused by the container's A2A handler...
    expect(requestOf(seen, octetStream.runtimeSessionId).contentType).toBe(
      'application/octet-stream',
    );
    // ...which the caller sees only as AgentCore's opaque runtime client error.
    expect(octetStream.invocation).toMatchObject({
      delivered: false,
      httpStatusCode: 424,
      jsonRpcError: {
        code: -32055,
        message: expect.stringMatching(/^Runtime client error/),
      },
    });

    // None sent, none forwarded — and the A2A handler accepts a request with
    // no content type at all.
    const noneSeen = requestOf(seen, none.runtimeSessionId);
    expect(noneSeen.contentType).toBeNull();
    expect([...noneSeen.headerNames].sort()).toEqual(
      defaultHeaderNames.filter((name) => name !== 'content-type'),
    );
    expect(
      taskFrom(none.invocation, 'message/send').metadata.negotiatedVersion,
    ).toBe('0.3');
  }, 300_000);
});
