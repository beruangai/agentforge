/**
 * ADR 0014 — the part shape is a wire question, not a version question.
 *
 * `@a2a-js/sdk@1.2.0` is protobuf-typed: its `Part` is
 * `{ content: { $case: 'data', value } }`, which is the SDK's INTERNAL
 * representation and was never a wire shape in either protocol version.
 * Measured on 2026-09-22 (docs/research/agentcore-runtime-observed.md),
 * varying one thing at a time: the silent strip is triggered by the 1.0 method
 * name `SendMessage`, not by the negotiated version. Choosing 1.0 puts
 * AgentForge permanently on the method name that exhibits it, which is why a
 * part reader must throw on a part it cannot decode.
 *
 * Asserted only on the strict 1.0 server — AgentForge's configuration. The
 * `message/send` and permissive-server rows of that measurement are recorded
 * in the note, not re-tested: AgentForge never runs them.
 *
 * And the 1.0 wire shape, captured from the SDK's own client: method
 * `SendMessage`, role `"ROLE_USER"`, a data part `{ data }` — no `kind`, no
 * `content`. A client must be handed the SDK's typed object and allowed to
 * serialise it.
 */
import { randomUUIDv7 } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probe } from './__fixtures__/probe.ts';
import {
  startVersionNegotiationServer,
  type VersionNegotiationServer,
} from './__fixtures__/version-negotiation-server.ts';

describe('what SendMessage does to a part it does not recognise (ADR 0014)', () => {
  let strict: VersionNegotiationServer;

  beforeAll(async () => {
    strict = await startVersionNegotiationServer({ a2aOneZeroOnly: true });
  });

  afterAll(async () => {
    await strict.close();
  });

  /** The part the executor was handed for the most recent message. */
  function lastReceivedPart(server: VersionNegotiationServer) {
    const last = server.received.at(-1);
    if (last === undefined || last.parts.length !== 1) {
      throw new Error(
        `expected the last message to carry one part: ${JSON.stringify(last)}`,
      );
    }
    return last.parts[0];
  }

  it('accepts the protobuf part shape under SendMessage and delivers it with its content silently gone', async () => {
    const outcome = await probe(strict.url, {
      method: 'SendMessage',
      partShape: 'protobuf',
      a2aVersion: '1.0',
      role: 1,
    });
    // No error at any layer: a task, carrying none of the payload.
    expect(outcome).toMatchObject({ kind: 'task', payloadArrived: false });
    expect(lastReceivedPart(strict)?.content).toBeUndefined();
  });

  it('delivers the wire part shape under SendMessage intact — the check can fail', async () => {
    expect(
      await probe(strict.url, {
        method: 'SendMessage',
        partShape: 'wire',
        a2aVersion: '1.0',
        role: 'user',
      }),
    ).toMatchObject({ kind: 'task', payloadArrived: true });
    expect(lastReceivedPart(strict)?.content?.$case).toBe('data');
  });

  it("puts a data part on the wire as { data } from the SDK's own client — neither the specification's { kind, data } nor its own { content }", async () => {
    const bodies: unknown[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return fetch(input, init);
    };
    const client = await new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    }).createFromAgentCard(strict.agentCard);
    const value = {
      runMilliseconds: 50,
      idempotencyKey: `wire-${randomUUIDv7()}`,
    };
    await client.sendMessage({
      tenant: '',
      message: {
        messageId: randomUUIDv7(),
        contextId: randomUUIDv7(),
        taskId: '',
        role: Role.ROLE_USER,
        parts: [
          {
            content: { $case: 'data', value },
            metadata: undefined,
            filename: '',
            mediaType: '',
          },
        ],
        metadata: undefined,
        extensions: [],
        referenceTaskIds: [],
      },
      configuration: {
        acceptedOutputModes: [],
        taskPushNotificationConfig: undefined,
        returnImmediately: true,
      },
      metadata: undefined,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      method: 'SendMessage',
      params: { message: { role: 'ROLE_USER', parts: [{ data: value }] } },
    });
    const [wirePart] = (
      bodies[0] as { params: { message: { parts: Record<string, unknown>[] } } }
    ).params.message.parts;
    expect(Object.keys(wirePart ?? {})).not.toContain('kind');
    expect(Object.keys(wirePart ?? {})).not.toContain('content');
    expect(lastReceivedPart(strict)?.content).toEqual({ $case: 'data', value });
  });
});
