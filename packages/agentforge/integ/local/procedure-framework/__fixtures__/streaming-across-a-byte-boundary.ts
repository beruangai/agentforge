/**
 * A stream over a custom link.
 *
 * A task is asynchronous, so the outcome is fetched. But a caller watching a
 * long run wants progress, and A2A has a streaming call. The question is
 * whether oRPC's event iterator survives AgentForge's transport, which is not
 * HTTP and not the RPC handler: a byte stream out of `InvokeAgentRuntime`.
 *
 * A link returning a generator it made itself would prove nothing — the
 * iterator would never leave the process. So this goes through the real
 * boundary: iterator -> bytes -> `Uint8Array` chunks -> iterator, the shape
 * `InvokeAgentRuntime`'s response body has.
 *
 * `asyncIteratorToStream` (v1's `eventIteratorToStream`, a deprecated alias
 * in v2) yields the EVENT OBJECTS, not encoded bytes — the v1 name suggested
 * otherwise, and the spike's first attempt was wrong because of it. oRPC's SSE encoding lives in its HTTP handler, which AgentForge does not
 * use, so the wire encoding is ours: `RPCSerializer` per event, one JSON line
 * each.
 */
import { arrayBuffer } from 'node:stream/consumers';
import {
  asyncIteratorToStream,
  type ClientLink,
  createORPCClient,
  RPCSerializer,
} from '@orpc/client';
import { type ContractRouterClient, eventIterator, oc } from '@orpc/contract';
import { implement } from '@orpc/server';
import { isAsyncIteratorObject } from '@orpc/shared';
import { z } from 'zod';
import { callByPath } from './in-memory-hop.ts';

export const progress = z.object({
  phase: z.enum(['BEFORE', 'RUN', 'AFTER']),
  note: z.string(),
  // Types JSON cannot carry, so their survival is the serializer's doing.
  observedAt: z.date(),
  sequence: z.bigint(),
});

export const streamingContract = {
  SubscribeToTask: oc
    .input(z.object({ taskId: z.string() }))
    .output(eventIterator(progress)),
};

const os = implement(streamingContract).$context<{ callerId: string }>();

export const streamingRouter = os.router({
  SubscribeToTask: os.SubscribeToTask.handler(async function* ({
    input,
    context,
  }) {
    yield {
      phase: 'BEFORE' as const,
      note: `${context.callerId} watching ${input.taskId}`,
      observedAt: new Date('2026-09-23T00:00:00.000Z'),
      sequence: 9_007_199_254_740_993n,
    };
    yield {
      phase: 'RUN' as const,
      note: 'one turn',
      observedAt: new Date('2026-09-23T00:00:01.000Z'),
      sequence: 9_007_199_254_740_994n,
    };
    yield {
      phase: 'AFTER' as const,
      note: 'settled',
      observedAt: new Date('2026-09-23T00:00:02.000Z'),
      sequence: 9_007_199_254_740_995n,
    };
  }),
});

/**
 * How the response body reaches the caller.
 *
 * - `STREAMED` — each frame as it is encoded: the link under test.
 * - `BUFFERED_BEFORE_DELIVERY` — the whole body collected first; the negative
 *   control that proves the interleaving check can fail.
 * - `TRUNCATED_MID_FRAME` — the body ends inside the last frame.
 */
export type Delivery =
  | 'STREAMED'
  | 'BUFFERED_BEFORE_DELIVERY'
  | 'TRUNCATED_MID_FRAME';

/**
 * The caller's half of the encoding: bytes back to events. Splitting on the
 * newline is ours, because the platform's line readers (`node:readline`)
 * cannot tell a final frame from a truncated one.
 */
async function* decode(
  body: ReadableStream<ArrayBufferView | ArrayBuffer>,
  serializer: RPCSerializer,
): AsyncGenerator<unknown> {
  let buffered = '';
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    buffered += text;
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length > 0) {
        yield serializer.deserialize(JSON.parse(line));
      }
      newline = buffered.indexOf('\n');
    }
  }
  // A body that ends mid-frame is a failure, never a tail silently dropped.
  if (buffered.length > 0) {
    throw new Error(`stream ended mid-frame: ${buffered}`);
  }
}

export function createStreamingClient(delivery: Delivery) {
  const serializer = new RPCSerializer();
  /** Each byte chunk put on the wire, as text. */
  const frames: string[] = [];
  /** `encode:<phase>` here; the test appends `receive:<phase>`. */
  const order: string[] = [];

  /** Stands in for InvokeAgentRuntime's response body: bytes, nothing else. */
  async function invokeAgentRuntimeStreaming(
    path: readonly string[],
    input: unknown,
  ): Promise<ReadableStream<Uint8Array>> {
    const iterator = await callByPath(streamingRouter, path, input, {
      context: { callerId: 'temporal-worker' },
    });
    if (!isAsyncIteratorObject(iterator)) {
      throw new Error(`${path.join('.')} did not return an event iterator`);
    }
    const events: ReadableStream<unknown> = asyncIteratorToStream(iterator);
    return events.pipeThrough(
      new TransformStream<unknown, Uint8Array>({
        transform(event, controller) {
          const { phase } = progress.parse(event);
          const line = `${JSON.stringify(serializer.serialize(event))}\n`;
          const bytes = new TextEncoder().encode(line);
          frames.push(line);
          order.push(`encode:${phase}`);
          controller.enqueue(
            delivery === 'TRUNCATED_MID_FRAME' && phase === 'AFTER'
              ? bytes.slice(0, Math.floor(bytes.byteLength / 2))
              : bytes,
          );
        },
      }),
    );
  }

  /** A full `ClientLink` — no cast, checked against the interface. */
  const link: ClientLink<Record<never, never>> = {
    async call(path, input) {
      const body = await invokeAgentRuntimeStreaming(path, input);
      return decode(
        delivery === 'BUFFERED_BEFORE_DELIVERY'
          ? ReadableStream.from([new Uint8Array(await arrayBuffer(body))])
          : body,
        serializer,
      );
    },
  };

  const client: ContractRouterClient<
    typeof streamingContract,
    Record<never, never>
  > = createORPCClient(link);
  return { client, frames, order };
}
