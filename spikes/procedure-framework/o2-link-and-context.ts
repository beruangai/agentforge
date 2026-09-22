/**
 * The two remaining questions about oRPC for AgentForge:
 *
 *  1. A CUSTOM LINK. AgentForge's transport is A2A over InvokeAgentRuntime, not
 *     HTTP. If a link can carry a typed call over an arbitrary transport, the
 *     client is ours without adapting AgentCore into HTTP. The hop here is
 *     in-memory and deliberately AgentCore-shaped — one JSON blob in, one JSON
 *     blob out — which is all InvokeAgentRuntime is.
 *
 *  2. TYPED CONTEXT THAT MIDDLEWARE CONTRIBUTES TO. This is the capability the
 *     operator wants preserved from tRPC and the thing that is expensive to
 *     retrofit: a reusable middleware adds a field, and every later middleware
 *     and the handler see it TYPED, without the procedure declaring it.
 *
 * Run: bun procedure-framework/o2-link-and-context.ts
 */
import { oc } from '@orpc/contract';
import { implement, call, createRouterClient } from '@orpc/server';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { ClientLink } from '@orpc/client';
import { z } from 'zod';

const taskHandle = z.object({ taskId: z.string(), state: z.literal('SUBMITTED') });
const contract = {
  reviewStrategy: {
    submit: oc.input(z.object({ strategyId: z.string(), depth: z.number() })).output(taskHandle),
    result: oc.input(z.object({ taskId: z.string() })).output(z.object({ verdict: z.enum(['PASS', 'FAIL']) })),
  },
};

// ── 2. middleware contributing typed context ───────────────────────────────
const base = implement(contract).$context<{ idempotencyKey: string; attempt: number }>();

/** A reusable house middleware. It RESOLVES something and adds it, typed. */
const withLease = base.middleware(async ({ context, next }) =>
  next({ context: { lease: { holder: `container-${context.attempt}`, generation: context.attempt } } }),
);
// The second middleware is defined ON the chain that already has withLease, so
// whether `context.lease` is TYPED here is the whole claim being tested. No
// cast: if the type does not flow, this does not compile.
const withLeaseApplied = base.use(withLease);
const os = withLeaseApplied.use(async ({ context, next }) =>
  next({ context: { audit: { startedAt: Date.now(), leaseHolder: context.lease.holder } } }),
);

const store = new Map<string, { verdict: 'PASS' | 'FAIL' }>();
let seen: Record<string, unknown> = {};

const router = os.router({
  reviewStrategy: {
    submit: os.reviewStrategy.submit.handler(async ({ input, context }) => {
      // Every contributed field must be visible AND typed here.
      seen = { idempotencyKey: context.idempotencyKey, lease: context.lease, audit: context.audit };
      const taskId = `task-${input.strategyId}`;
      store.set(taskId, { verdict: input.depth > 2 ? 'PASS' : 'FAIL' });
      return { taskId, state: 'SUBMITTED' as const };
    }),
    result: os.reviewStrategy.result.handler(async ({ input }) => store.get(input.taskId) ?? { verdict: 'FAIL' as const }),
  },
});

console.log('\noRPC v2 — a custom link, and middleware-contributed context\n');

const context = { idempotencyKey: 'idem-1', attempt: 3 };

// ── 1. the custom link ─────────────────────────────────────────────────────
/** Stands in for InvokeAgentRuntime: one JSON blob in, one JSON blob out. */
const wire: { sent: unknown[] } = { sent: [] };
async function invokeAgentRuntime(payload: string): Promise<string> {
  const { path, input } = JSON.parse(payload);
  wire.sent.push({ path, input });
  const server = createRouterClient(router, { context });
  let node: any = server;
  for (const segment of path) node = node[segment];
  return JSON.stringify({ output: await node(input) });
}

/** The whole link. This is the seam AgentForge would own. */
const agentCoreLink: ClientLink<Record<never, never>> = {
  async call(path, input, _options) {
    const response = await invokeAgentRuntime(JSON.stringify({ path, input }));
    return JSON.parse(response).output;
  },
};

// Typed from the CONTRACT, over a link that knows nothing about HTTP. If this
// is not typed, oRPC buys AgentForge nothing a plain function would not.
const client: ContractRouterClient<typeof contract, Record<never, never>> = createORPCClient(agentCoreLink);

const handle = await client.reviewStrategy.submit({ strategyId: 'alpha', depth: 5 });
console.log('  through the link, submit ->', JSON.stringify(handle));
const outcome = await client.reviewStrategy.result({ taskId: handle.taskId });
console.log('  through the link, result ->', JSON.stringify(outcome));
console.log('  envelope the link put on the wire ->', JSON.stringify(wire.sent[0]));

console.log('\n  context the handler saw:');
for (const [k, v] of Object.entries(seen)) console.log(`    ${k.padEnd(16)} ${JSON.stringify(v)}`);

// ── error fidelity ─────────────────────────────────────────────────────────
const boom = implement({ fail: oc.input(z.object({})).output(z.object({})) }).$context<{}>();
const failing = boom.router({
  fail: boom.fail.handler(async () => {
    throw new Error('a raw error with a real stack');
  }),
});
try {
  await call(failing.fail, {}, { context: {} });
} catch (error: any) {
  console.log(`\n  raw error survives?  ${error?.message === 'a raw error with a real stack' ? `YES — "${error.message}"` : `NO — became ${error?.constructor?.name}: ${error?.message}`}`);
  console.log(`  stack preserved?     ${typeof error?.stack === 'string' && error.stack.includes('o2-link-and-context') ? 'YES' : 'NO'}`);
}

// ── do the types survive the link? checked by tsc, not at run time ─────────
async function clientTypeProbes() {
  // @ts-expect-error the link's client rejects an unknown input field
  await client.reviewStrategy.submit({ strategyId: 'a', depth: 1, bogus: true });
  // @ts-expect-error and a wrong field type
  await client.reviewStrategy.submit({ strategyId: 'a', depth: 'deep' });
  const h = await client.reviewStrategy.submit({ strategyId: 'a', depth: 1 });
  // @ts-expect-error the handle is not the outcome
  const wrong: 'PASS' | 'FAIL' = h.verdict;
  const state: 'SUBMITTED' = h.state;
  const verdict: 'PASS' | 'FAIL' = (await client.reviewStrategy.result({ taskId: h.taskId })).verdict;
  void wrong; void state; void verdict;
}
void clientTypeProbes;
console.log();
