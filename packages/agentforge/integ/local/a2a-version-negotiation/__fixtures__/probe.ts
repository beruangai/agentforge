import { randomUUIDv7 } from 'node:crypto';

/**
 * A fresh idempotency key per probe, echoed back by the fixture, so an answer
 * is proved to carry THIS probe's payload. On the spike's first run a shared
 * constant key made every probe echo the first result through the gateway's
 * idempotency index — reporting the permissive server as negotiating 0.3 for
 * cases that negotiate 1.0. The measurement was defeated by the thing being
 * measured.
 */
function freshPayload(): { runMilliseconds: number; idempotencyKey: string } {
  return { runMilliseconds: 50, idempotencyKey: `probe-${randomUUIDv7()}` };
}

export type PartShape =
  /** `{ kind: 'data', data }` — how the specification's JSON examples write a part. */
  | 'wire'
  /** `{ content: { $case: 'data', value } }` — the SDK's INTERNAL protobuf type, never a wire shape. */
  | 'protobuf';

export interface ProbeRequest {
  readonly method: 'message/send' | 'SendMessage';
  readonly partShape: PartShape;
  /** The `A2A-Version` header; absent when undefined. */
  readonly a2aVersion: '0.3' | '1.0' | undefined;
  /** `'user'` as 0.3 spells it, or the SDK's numeric `Role.ROLE_USER`. */
  readonly role: 'user' | 1;
}

export type ProbeOutcome =
  | {
      readonly kind: 'task';
      readonly negotiatedVersion: string;
      /** Whether the echoed key is the one this probe sent. */
      readonly payloadArrived: boolean;
    }
  | { readonly kind: 'error'; readonly code: number; readonly message: string };

/** One raw JSON-RPC call, the way the spike probed both servers. */
export async function probe(
  url: string,
  request: ProbeRequest,
): Promise<ProbeOutcome> {
  const payload = freshPayload();
  const part =
    request.partShape === 'wire'
      ? { kind: 'data', data: payload }
      : {
          content: { $case: 'data', value: payload },
          filename: '',
          mediaType: '',
        };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (request.a2aVersion !== undefined) {
    headers['A2A-Version'] = request.a2aVersion;
  }
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUIDv7(),
      method: request.method,
      params: {
        message: {
          kind: 'message',
          messageId: randomUUIDv7(),
          role: request.role,
          contextId: randomUUIDv7(),
          parts: [part],
        },
        configuration: { blocking: false },
      },
    }),
  });
  const body = (await response.json()) as {
    result?: { metadata?: unknown; task?: { metadata?: unknown } };
    error?: { code: number; message: string };
  };
  if (body.error !== undefined) {
    return {
      kind: 'error',
      code: body.error.code,
      message: body.error.message,
    };
  }
  // 0.3 answers the task; 1.0 answers `{ task }`.
  const metadata = (body.result?.metadata ?? body.result?.task?.metadata) as
    | { negotiatedVersion: string; idempotencyKey: string | null }
    | undefined;
  if (metadata === undefined) {
    throw new Error(
      `${request.method} answered neither an error nor a task with metadata: ${JSON.stringify(body)}`,
    );
  }
  return {
    kind: 'task',
    negotiatedVersion: metadata.negotiatedVersion,
    payloadArrived: metadata.idempotencyKey === payload.idempotencyKey,
  };
}
