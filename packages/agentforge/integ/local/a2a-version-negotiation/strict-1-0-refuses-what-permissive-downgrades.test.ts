/**
 * ADR 0014 — can AgentForge run A2A 1.0 ONLY, and never carry 0.3? (ADR 0014)
 *
 * A2A is AgentForge's transport, never exposed to a consumer or an agent, so
 * there is no caller to stay compatible with. The question is whether
 * `@a2a-js/sdk` permits it — a card declaring one interface, `legacyCompat`
 * off — and what a 0.3 caller then gets. Measured on 2026-09-22
 * (docs/research/agentcore-runtime-observed.md), two servers side by side:
 *
 *   | Request                              | Strict                        | Permissive         |
 *   | no A2A-Version                       | -32009 '0.3' is not supported | OK, negotiates 0.3 |
 *   | A2A-Version: 0.3                     | -32009                        | OK, negotiates 0.3 |
 *   | A2A-Version: 1.0 + message/send      | -32601 Invalid method         | OK                 |
 *   | A2A-Version: 1.0 + SendMessage       | OK, negotiates 1.0            | OK, negotiates 1.0 |
 *
 * An absent header is not "unspecified" — it is 0.3. So with `legacyCompat`
 * ON, a missing or misspelt `A2A-Version` allowlist entry downgrades every call
 * to 0.3 and the system appears to work on the wrong protocol; with it OFF the
 * same mistake fails on the first call. Advice given earlier in the same
 * session — "keep legacyCompat enabled as a safety net" — was backwards, and
 * this keeps it from coming back.
 *
 * The permissive column is the control: the same request succeeds there, so a
 * strict refusal is the configuration's doing, not a malformed probe.
 *
 * And 1.0 only needs nothing on the client: the SDK's own `ClientFactory` over
 * `JsonRpcTransportFactory`, built from the 1.0-only card, sends
 * `A2A-Version: 1.0` and `SendMessage` by itself.
 */
import { randomUUIDv7 } from 'node:crypto';
import { Role } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory } from '@a2a-js/sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ProbeRequest, probe } from './__fixtures__/probe.ts';
import {
  startVersionNegotiationServer,
  type VersionNegotiationServer,
} from './__fixtures__/version-negotiation-server.ts';

const VERSION_NOT_SUPPORTED = {
  kind: 'error',
  code: -32009,
  message: expect.stringContaining(
    "The requested A2A protocol version '0.3' is not supported",
  ),
} as const;

const MATRIX: {
  label: string;
  request: ProbeRequest;
  strict: unknown;
  permissive: unknown;
}[] = [
  {
    label: 'no A2A-Version, message/send',
    request: {
      method: 'message/send',
      partShape: 'wire',
      a2aVersion: undefined,
      role: 'user',
    },
    strict: VERSION_NOT_SUPPORTED,
    permissive: {
      kind: 'task',
      negotiatedVersion: '0.3',
      payloadArrived: true,
    },
  },
  {
    label: 'A2A-Version: 0.3, message/send',
    request: {
      method: 'message/send',
      partShape: 'wire',
      a2aVersion: '0.3',
      role: 'user',
    },
    strict: VERSION_NOT_SUPPORTED,
    permissive: {
      kind: 'task',
      negotiatedVersion: '0.3',
      payloadArrived: true,
    },
  },
  {
    label: 'A2A-Version: 1.0, message/send',
    request: {
      method: 'message/send',
      partShape: 'wire',
      a2aVersion: '1.0',
      role: 'user',
    },
    strict: {
      kind: 'error',
      code: -32601,
      message: expect.stringMatching(/method/i),
    },
    permissive: { kind: 'task', payloadArrived: true },
  },
  {
    label: 'no A2A-Version, SendMessage',
    request: {
      method: 'SendMessage',
      partShape: 'wire',
      a2aVersion: undefined,
      role: 'user',
    },
    strict: VERSION_NOT_SUPPORTED,
    permissive: {
      kind: 'task',
      negotiatedVersion: '0.3',
      payloadArrived: true,
    },
  },
  {
    label: 'A2A-Version: 0.3, SendMessage',
    request: {
      method: 'SendMessage',
      partShape: 'wire',
      a2aVersion: '0.3',
      role: 'user',
    },
    strict: VERSION_NOT_SUPPORTED,
    permissive: {
      kind: 'task',
      negotiatedVersion: '0.3',
      payloadArrived: true,
    },
  },
  {
    label: 'A2A-Version: 1.0, SendMessage',
    request: {
      method: 'SendMessage',
      partShape: 'wire',
      a2aVersion: '1.0',
      role: 'user',
    },
    strict: { kind: 'task', negotiatedVersion: '1.0', payloadArrived: true },
    permissive: {
      kind: 'task',
      negotiatedVersion: '1.0',
      payloadArrived: true,
    },
  },
];

describe('A2A 1.0 only, or 1.0 with 0.3 underneath (ADR 0014, ADR 0014)', () => {
  let strict: VersionNegotiationServer;
  let permissive: VersionNegotiationServer;

  beforeAll(async () => {
    strict = await startVersionNegotiationServer({ a2aOneZeroOnly: true });
    permissive = await startVersionNegotiationServer({
      a2aOneZeroOnly: false,
    });
  });

  afterAll(async () => {
    await Promise.all([strict.close(), permissive.close()]);
  });

  it.each(MATRIX)(
    'strict refuses what permissive downgrades: $label',
    async ({
      request,
      strict: strictOutcome,
      permissive: permissiveOutcome,
    }) => {
      expect(await probe(strict.url, request)).toEqual(strictOutcome);
      expect(await probe(permissive.url, request)).toEqual(
        expect.objectContaining(permissiveOutcome as object),
      );
    },
  );

  it("the SDK's own client, built from the 1.0-only card, sends A2A-Version: 1.0 and SendMessage by itself, and 1.0 is negotiated", async () => {
    const sent: { a2aVersion: string | null; method: unknown }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      sent.push({
        a2aVersion: new Headers(init?.headers).get('A2A-Version'),
        method: (JSON.parse(String(init?.body)) as { method: unknown }).method,
      });
      return fetch(input, init);
    };
    const client = await new ClientFactory({
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
    }).createFromAgentCard(strict.agentCard);
    const idempotencyKey = `client-${randomUUIDv7()}`;
    const result = await client.sendMessage({
      tenant: '',
      message: {
        messageId: randomUUIDv7(),
        contextId: randomUUIDv7(),
        taskId: '',
        role: Role.ROLE_USER,
        parts: [
          {
            content: {
              $case: 'data',
              value: { runMilliseconds: 50, idempotencyKey },
            },
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

    expect(sent).toEqual([{ a2aVersion: '1.0', method: 'SendMessage' }]);
    if (!('status' in result)) {
      throw new Error(
        `SendMessage answered a message, not a task: ${JSON.stringify(result)}`,
      );
    }
    expect(result.metadata).toEqual({
      negotiatedVersion: '1.0',
      idempotencyKey,
    });
  });
});
