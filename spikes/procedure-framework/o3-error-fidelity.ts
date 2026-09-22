import { oc } from '@orpc/contract';
import { implement, call, createRouterClient } from '@orpc/server';
import { createORPCClient, ORPCError, isDefinedError } from '@orpc/client';
import { RPCSerializer } from '@orpc/client';
import { z } from 'zod';

const contract = { fail: oc.input(z.object({ kind: z.string() })).output(z.object({ ok: z.boolean() })) };
const os = implement(contract).$context<Record<never, never>>();
const router = os.router({
  fail: os.fail.handler(async ({ input }) => {
    if (input.kind === 'raw') throw new Error('a raw error with a real stack');
    if (input.kind === 'orpc') throw new ORPCError('LEASE_LOST', { message: 'the lease generation was stale', data: { generation: 7 } });
    return { ok: true };
  }),
});

// A transport that actually SERIALISES, the way InvokeAgentRuntime does.
const serializer = new RPCSerializer();
const link = {
  async call(path: readonly string[], input: unknown) {
    const server = createRouterClient(router, { context: {} });
    let node: any = server;
    for (const s of path) node = node[s];
    let wire: string;
    try {
      wire = JSON.stringify({ ok: true, body: serializer.serialize(await node(input)) });
    } catch (error: any) {
      // What a container can put on the wire about a failure.
      wire = JSON.stringify({ ok: false, body: serializer.serialize(error instanceof ORPCError ? error.toJSON() : { name: error?.name, message: error?.message, stack: error?.stack }) });
    }
    const parsed = JSON.parse(wire);
    const body: any = serializer.deserialize(parsed.body);
    if (parsed.ok) return body;
    throw body?.defined !== undefined || body?.code ? new ORPCError(body.code ?? 'UNKNOWN', body) : Object.assign(new Error(body?.message ?? 'unknown'), { stack: body?.stack, name: body?.name });
  },
};
const client: any = createORPCClient(link as any);

console.log('\n  error fidelity ACROSS a serialising transport\n');
for (const kind of ['raw', 'orpc']) {
  try {
    await client.fail({ kind });
  } catch (error: any) {
    const hasStack = typeof error?.stack === 'string' && error.stack.includes('o3-error-fidelity');
    console.log(`  ${kind.padEnd(5)} -> ${error?.constructor?.name.padEnd(10)} message="${error?.message}"`);
    console.log(`           original stack survives: ${hasStack ? 'YES' : 'NO'}  data=${JSON.stringify(error?.data ?? null)}`);
  }
}
console.log();
