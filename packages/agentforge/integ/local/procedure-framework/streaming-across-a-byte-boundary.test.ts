/**
 * An oRPC event stream survives a non-HTTP link as bytes, streamed rather than
 * buffered — recorded in docs/research/procedure-framework.md.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  createStreamingClient,
  type Delivery,
  type progress,
} from './__fixtures__/streaming-across-a-byte-boundary.ts';

async function subscribe(delivery: Delivery) {
  const { client, frames, order } = createStreamingClient(delivery);
  const stream = await client.SubscribeToTask({ taskId: 'task-1' });
  const received: z.infer<typeof progress>[] = [];
  for await (const event of stream) {
    received.push(event);
    order.push(`receive:${event.phase}`);
  }
  return { received, frames, order };
}

describe('an event stream across a byte boundary', () => {
  it('delivers every event, typed, one frame per event', async () => {
    const { received, frames } = await subscribe('STREAMED');

    expect(received).toStrictEqual([
      {
        phase: 'BEFORE',
        note: 'temporal-worker watching task-1',
        observedAt: new Date('2026-09-23T00:00:00.000Z'),
        sequence: 9_007_199_254_740_993n,
      },
      {
        phase: 'RUN',
        note: 'one turn',
        observedAt: new Date('2026-09-23T00:00:01.000Z'),
        sequence: 9_007_199_254_740_994n,
      },
      {
        phase: 'AFTER',
        note: 'settled',
        observedAt: new Date('2026-09-23T00:00:02.000Z'),
        sequence: 9_007_199_254_740_995n,
      },
    ]);
    expect(frames).toHaveLength(3);
    for (const frame of frames) {
      expect(frame.indexOf('\n')).toBe(frame.length - 1);
    }
  });

  it('is streamed, not buffered: the caller sees progress before the run ends', async () => {
    const { order } = await subscribe('STREAMED');

    expect(order).toStrictEqual([
      'encode:BEFORE',
      'receive:BEFORE',
      'encode:RUN',
      'receive:RUN',
      'encode:AFTER',
      'receive:AFTER',
    ]);
  });

  it('shows the batched order when the body is buffered — the check can fail', async () => {
    const { order } = await subscribe('BUFFERED_BEFORE_DELIVERY');

    expect(order).toStrictEqual([
      'encode:BEFORE',
      'encode:RUN',
      'encode:AFTER',
      'receive:BEFORE',
      'receive:RUN',
      'receive:AFTER',
    ]);
  });

  it('fails the caller’s iteration on a body that ends mid-frame, after the whole frames', async () => {
    const received: string[] = [];
    const { client } = createStreamingClient('TRUNCATED_MID_FRAME');
    const stream = await client.SubscribeToTask({ taskId: 'task-1' });

    await expect(async () => {
      for await (const event of stream) {
        received.push(event.phase);
      }
    }).rejects.toThrow('stream ended mid-frame');
    expect(received).toStrictEqual(['BEFORE', 'RUN']);
  });
});
