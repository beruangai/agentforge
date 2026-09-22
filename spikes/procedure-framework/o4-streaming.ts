/**
 * GAP 1 — STREAMING OVER A CUSTOM LINK.
 *
 * A task is asynchronous, so the outcome is fetched. But a caller watching a
 * long run wants progress, and A2A has a streaming send. The question is
 * whether oRPC's event iterator survives AgentForge's transport, which is not
 * HTTP and not the RPC handler: a BYTE STREAM out of InvokeAgentRuntime.
 *
 * A link returning a generator it made itself would prove nothing — the
 * iterator would never leave the process. So this goes through the real
 * boundary: iterator -> SSE byte stream -> Uint8Array chunks -> iterator, the
 * same shape InvokeAgentRuntime's response body has.
 *
 * Run: bun procedure-framework/o4-streaming.ts
 */
import { oc, eventIterator } from '@orpc/contract';
import { implement, createRouterClient } from '@orpc/server';
import { createORPCClient, eventIteratorToStream, RPCSerializer } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { ClientLink } from '@orpc/client';
import { z } from 'zod';

const progress = z.object({ phase: z.enum(['BEFORE', 'RUN', 'AFTER']), note: z.string() });

const contract = {
  watch: oc.input(z.object({ taskId: z.string() })).output(eventIterator(progress)),
};

const os = implement(contract).$context<{ callerId: string }>();

const router = os.router({
  watch: os.watch.handler(async function* ({ input, context }) {
    yield { phase: 'BEFORE' as const, note: `${context.callerId} watching ${input.taskId}` };
    yield { phase: 'RUN' as const, note: 'one turn' };
    yield { phase: 'AFTER' as const, note: 'settled' };
  }),
});

console.log('\noRPC v2 — does a stream survive a non-HTTP link?\n');

const server = createRouterClient(router, { context: { callerId: 'temporal-worker' } });

/** Stands in for InvokeAgentRuntime's response body: bytes, nothing else. */
const wire: { chunks: number; bytes: number; first: string } = { chunks: 0, bytes: 0, first: '' };
const order: string[] = [];
const serializer = new RPCSerializer();

async function invokeAgentRuntimeStreaming(
  path: readonly string[],
  input: unknown,
): Promise<ReadableStream<Uint8Array>> {
  let node: any = server;
  for (const segment of path) node = node[segment];
  const iterator = await node(input);

  // FINDING: eventIteratorToStream yields the EVENT OBJECTS, not encoded bytes.
  // oRPC's SSE encoding lives in its HTTP handler, which AgentForge does not
  // use. So the wire encoding is ours — RPCSerializer per event, one JSON line
  // each — and it is written here rather than assumed.
  const objects: ReadableStream<unknown> = eventIteratorToStream(iterator);
  return objects.pipeThrough(
    new TransformStream<unknown, Uint8Array>({
      transform(event, controller) {
        const line = `${JSON.stringify(serializer.serialize(event))}\n`;
        const bytes = new TextEncoder().encode(line);
        wire.chunks += 1;
        wire.bytes += bytes.byteLength;
        wire.first ||= line.trim();
        order.push(`encode:${(event as any).phase}`);
        controller.enqueue(bytes);
      },
    }),
  );
}

/** The caller's half of that encoding: bytes back to an event iterator. */
async function* decode(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line) yield serializer.deserialize(JSON.parse(line));
    }
  }
  if (buffered.trim()) throw new Error(`stream ended mid-frame: ${buffered}`);
}

/** A full ClientLink — no cast, checked against the interface. */
const streamingLink: ClientLink<Record<never, never>> = {
  async call(path, input, _options) {
    return decode(await invokeAgentRuntimeStreaming(path, input));
  },
};

const client: ContractRouterClient<typeof contract, Record<never, never>> = createORPCClient(streamingLink);

const stream = await client.watch({ taskId: 'task-1' });
const received: { phase: string; note: string }[] = [];
for await (const event of stream) {
  // `event` is typed off the contract here — no cast.
  received.push(event);
  order.push(`receive:${event.phase}`);
  console.log(`  event  ${event.phase.padEnd(7)} ${event.note}`);
}

console.log(`\n  events received       ${received.length}`);
console.log(`  byte chunks on wire   ${wire.chunks} (${wire.bytes} bytes)`);
console.log(`  first frame           ${wire.first}`);
// Batched would be encode,encode,encode,receive,receive,receive. Interleaved
// means a caller sees progress before the run ends, which is the whole point.
const batched = order.slice(0, received.length).every((step) => step.startsWith('encode'));
console.log(`  interleaved?          ${batched ? 'NO — fully buffered first' : 'YES'}`);
console.log(`  order                 ${order.join(' ')}`);

// ── type probes: checked by tsc, not at run time ───────────────────────────
async function probes() {
  const s = await client.watch({ taskId: 't' });
  for await (const event of s) {
    const phase: 'BEFORE' | 'RUN' | 'AFTER' = event.phase;
    // @ts-expect-error the yielded shape is typed from the contract
    const bogus: string = event.missing;
    void phase; void bogus;
  }
  // @ts-expect-error input is still validated through a streaming link
  await client.watch({ taskId: 't', extra: 1 });
}
void probes;
console.log();
