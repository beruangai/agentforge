/**
 * GAP 2 — CANCELLATION, and GAP 3 — A LINK THAT NEEDS NO CAST.
 *
 * o2 first wrote its link as a bare object literal passed with `as any`, which
 * left the link's own typing unproven. Two things hang on it:
 *
 *   A. CLIENT CONTEXT. `ClientLink<TClientContext>` types what a CALLER must
 *      supply per call, separately from the input. AgentForge needs exactly
 *      this for the idempotency key: it is not part of a procedure's input —
 *      no procedure should declare it — but no submit may go without one.
 *      If the compiler enforces that, the key cannot be forgotten.
 *
 *   B. CANCELLATION. oRPC threads an AbortSignal to middleware and handler.
 *      AgentForge cancels out of band — a CancelTask arrives as its own
 *      invocation, not as a dropped connection — so what matters is whether a
 *      signal AgentForge raises itself is visible to a running procedure.
 *
 * Run: bun procedure-framework/o5-cancellation-and-typed-link.ts
 */
import { oc } from '@orpc/contract';
import { implement, createRouterClient } from '@orpc/server';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { ClientLink } from '@orpc/client';
import { z } from 'zod';

const contract = {
  submit: oc
    .input(z.object({ strategyId: z.string() }))
    .output(z.object({ taskId: z.string(), state: z.literal('SUBMITTED') })),
  runLong: oc.input(z.object({ milliseconds: z.number() })).output(z.object({ finished: z.boolean() })),
};

const base = implement(contract).$context<{ callerId: string }>();

/** A house middleware that sees the signal, as a lease renewer would. */
const observed: Record<string, unknown> = {};
const os = base.use(async ({ context, signal, next }) => {
  observed.middlewareSawSignal = signal !== undefined;
  observed.middlewareAbortedAtEntry = signal?.aborted ?? null;
  return next({ context: { deadline: { signal } } });
});

const router = os.router({
  submit: os.submit.handler(async ({ input }) => ({ taskId: `task-${input.strategyId}`, state: 'SUBMITTED' as const })),
  runLong: os.runLong.handler(async ({ input, signal, context }) => {
    // The typed context carries the same signal the middleware saw.
    observed.handlerSawSameSignal = context.deadline.signal === signal;
    // A real procedure races its work against the signal. No polling.
    const finished = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), input.milliseconds);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    observed.handlerObservedAbort = signal?.aborted ?? null;
    return { finished };
  }),
});

console.log('\noRPC v2 — cancellation, and a link with no cast\n');

// ── A. a link whose client context the compiler enforces ───────────────────
/** What every caller must supply per call, beside the input. */
type CallerContext = { idempotencyKey: string };

const seenByLink: { key?: string; hadSignal?: boolean; path?: string[] } = {};

const agentCoreLink: ClientLink<CallerContext> = {
  async call(path, input, options) {
    // Both are typed off ClientLink — no cast, no `any`.
    const key: string = options.context.idempotencyKey;
    const signal: AbortSignal | undefined = options.signal;
    seenByLink.key = key;
    seenByLink.hadSignal = signal !== undefined;
    seenByLink.path = [...path];

    // AgentForge's real hop: the caller's signal cannot travel with the call,
    // so the container is given one it controls. A dropped caller signal would
    // be a silent failure, so the link raises the out-of-band cancel instead.
    const containerAbort = new AbortController();
    signal?.addEventListener('abort', () => containerAbort.abort(signal.reason));

    const server = createRouterClient(router, { context: { callerId: 'temporal-worker' } });
    let node: any = server;
    for (const segment of path) node = node[segment];
    return node(input, { signal: containerAbort.signal });
  },
};

const client: ContractRouterClient<typeof contract, CallerContext> = createORPCClient(agentCoreLink);

const handle = await client.submit({ strategyId: 'alpha' }, { context: { idempotencyKey: 'idem-7' } });
console.log(`  submit ->            ${JSON.stringify(handle)}`);
console.log(`  link saw key         ${seenByLink.key}`);
console.log(`  link saw path        ${JSON.stringify(seenByLink.path)}`);

// ── B. cancellation, end to end ────────────────────────────────────────────
const caller = new AbortController();
setTimeout(() => caller.abort(new Error('CancelTask arrived')), 60);
const started = Date.now();
const outcome = await client.runLong(
  { milliseconds: 5_000 },
  { context: { idempotencyKey: 'idem-8' }, signal: caller.signal },
);
const elapsed = Date.now() - started;

console.log(`\n  link saw signal      ${seenByLink.hadSignal ? 'YES' : 'NO'}`);
for (const [k, v] of Object.entries(observed)) console.log(`  ${k.padEnd(20)} ${JSON.stringify(v)}`);
console.log(`  runLong finished     ${outcome.finished}`);
console.log(`  returned after       ${elapsed}ms (the work asked for 5000ms)`);
console.log(`  cancelled in time?   ${!outcome.finished && elapsed < 1_000 ? 'YES' : 'NO'}`);

// ── type probes: checked by tsc, not at run time ───────────────────────────
async function probes() {
  // @ts-expect-error a call with no client context does not compile: the
  // idempotency key cannot be forgotten, and no procedure had to declare it
  await client.submit({ strategyId: 'a' });
  // @ts-expect-error nor with the wrong client context
  await client.submit({ strategyId: 'a' }, { context: { idempotency: 'a' } });
  // A link that DEMANDS MORE than the client promises is rejected, so the two
  // halves cannot drift apart:
  const demanding: ClientLink<CallerContext & { tenant: string }> = {
    async call(_path, _input, options) {
      return options.context.tenant;
    },
  };
  // @ts-expect-error the client only promises an idempotencyKey
  const mismatched: ContractRouterClient<typeof contract, CallerContext> = createORPCClient(demanding);

  // NOT a hole, and NOT probed as one: a link may declare a LOOSER context
  // than the client requires. That is ordinary contravariance — the link
  // simply ignores what it was handed. The requirement is enforced by the
  // CLIENT's annotation, which is therefore the thing AgentForge must own and
  // not let a consumer write; see the research note.

  const right = await client.submit({ strategyId: 'a' }, { context: { idempotencyKey: 'k' } });
  const state: 'SUBMITTED' = right.state;
  void mismatched; void state;
}
void probes;
console.log();
