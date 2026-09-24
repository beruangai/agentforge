// biome-ignore-all format: a @ts-expect-error covers only the line after it, so reflowing a probe would move its error off that line
/**
 * Type probes, compiled by the `typecheck` target (`tsconfig.spec.json`
 * includes `integ/`) under the project's strict settings. Each
 * `@ts-expect-error` must still be an error; one that stops erroring is
 * reported as unused (TS2578) and fails `typecheck`.
 */
import { expectTypeOf } from 'vitest';
import { createStreamingClient } from './streaming-across-a-byte-boundary.ts';

export async function streamingTypeProbes() {
  const { client } = createStreamingClient('STREAMED');

  const stream = await client.SubscribeToTask({ taskId: 't' });
  for await (const event of stream) {
    // Each yielded event is typed off the contract, with no cast.
    expectTypeOf(event).toEqualTypeOf<{
      phase: 'BEFORE' | 'RUN' | 'AFTER';
      note: string;
      observedAt: Date;
      sequence: bigint;
    }>();
    // @ts-expect-error the yielded shape is the contract's, not open-ended
    void event.missing;
  }

  // @ts-expect-error input is still checked through a streaming link
  await client.SubscribeToTask({ taskId: 't', extra: 1 });
}
