/**
 * THE SPLIT, NAMED — A2A's own verbs, and what each call requires.
 *
 * Two things the operator settled, and one they asked to be determined:
 *
 *  1. NO INVENTED VERBS. The wire is A2A, so the derived procedures are named
 *     `SendMessage`, `GetTask` and `CancelTask` verbatim. `create`/`status`
 *     were a translation layer over terms that already exist, and `status`
 *     was actively misleading once it carried the outcome.
 *     Leaf procedures are PascalCase; namespaces are camelCase.
 *
 *  2. `CancelTask` IS ROOT-LEVEL, NOT PER PROCEDURE. It needs a task id and a
 *     runtime session id to reach the right container. Both are the CALLER's
 *     ([ADR 0007]) and neither comes from a contract, so a per-procedure copy
 *     would be the same signature repeated once per procedure.
 *
 *  3. So what carries `runtimeSessionId`? It is transport routing — the
 *     AgentCore session header — not any procedure's input. It belongs in the
 *     CLIENT CONTEXT beside the idempotency key. But the two are not required
 *     on the same calls: an idempotency key means nothing on a poll or a
 *     cancel, and demanding one there would make a caller invent a value.
 *
 * THE QUESTION THIS SPIKE ANSWERS: `RouterContractClient` distributes ONE
 * context type over every leaf. Can AgentForge still require the idempotency
 * key on `SendMessage` ALONE, without demanding it on the others?
 *
 * Run: bun procedure-framework/o7-a2a-verbs-and-per-call-context.ts
 */
import { oc } from '@orpc/contract';
import { implement, createRouterClient } from '@orpc/server';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { ClientLink } from '@orpc/client';
import { z } from 'zod';

// ── what every procedure shares ────────────────────────────────────────────
const taskHandle = z.object({ taskId: z.string(), contextId: z.string(), state: z.literal('SUBMITTED') });
const taskQuery = z.object({ taskId: z.string() });
const failureCause = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('OUTPUT_INVALID'), payload: z.string() }),
  z.object({ kind: z.literal('LOST') }),
]);

function split<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(c: { input: I; output: O }) {
  return {
    SendMessage: oc.input(c.input).output(taskHandle),
    GetTask: oc.input(taskQuery).output(
      z.discriminatedUnion('state', [
        z.object({ state: z.literal('SUBMITTED') }),
        z.object({ state: z.literal('WORKING'), startedAt: z.string() }),
        z.object({ state: z.literal('SUCCEEDED'), output: c.output }),
        z.object({ state: z.literal('FAILED'), cause: failureCause }),
      ]),
    ),
  };
}

/** Namespaces camelCase; leaf procedures PascalCase. `CancelTask` is root. */
const contract = {
  reviewStrategy: split({
    input: z.object({ strategyId: z.string(), depth: z.number() }),
    output: z.object({ verdict: z.enum(['PASS', 'FAIL']), score: z.number() }),
  }),
  summariseCorpus: split({
    input: z.object({ corpusId: z.string() }),
    output: z.object({ summary: z.string() }),
  }),
  CancelTask: oc.input(taskQuery).output(z.object({ state: z.enum(['CANCELLED', 'SUCCEEDED', 'FAILED']) })),
};

// ── the two call contexts ──────────────────────────────────────────────────
/** Routing. Required on EVERY call, because every call reaches a container. */
type Routed = { runtimeSessionId: string };
/** Starting work. Only a start is idempotent, so only a start needs the key. */
type Starting = Routed & { idempotencyKey: string };

/**
 * The client type AgentForge vends. `RouterContractClient` applies one context
 * to a whole router, so it is applied PER LEAF instead — which is the point of
 * AgentForge owning this type rather than a consumer writing it.
 */
type AgentForgeClient = {
  [Namespace in keyof Omit<typeof contract, 'CancelTask'>]: {
    SendMessage: ContractRouterClient<(typeof contract)[Namespace]['SendMessage'], Starting>;
    GetTask: ContractRouterClient<(typeof contract)[Namespace]['GetTask'], Routed>;
  };
} & {
  CancelTask: ContractRouterClient<(typeof contract)['CancelTask'], Routed>;
};

// ── the server, and a link that reads both context fields ──────────────────
const os = implement(contract).$context<{ callerId: string }>();
const rows = new Map<string, any>();
let next = 0;

const router = os.router({
  reviewStrategy: {
    SendMessage: os.reviewStrategy.SendMessage.handler(async ({ input }) => {
      const taskId = `task-${++next}`;
      rows.set(taskId, { state: 'WORKING', startedAt: new Date().toISOString() });
      setTimeout(() => rows.set(taskId, { state: 'SUCCEEDED', output: { verdict: 'PASS', score: input.depth * 10 } }), 25);
      return { taskId, contextId: 'ctx-1', state: 'SUBMITTED' as const };
    }),
    GetTask: os.reviewStrategy.GetTask.handler(async ({ input }) => {
      const row = rows.get(input.taskId);
      if (!row) throw new Error(`no such task: ${input.taskId}`);
      return row;
    }),
  },
  summariseCorpus: {
    SendMessage: os.summariseCorpus.SendMessage.handler(async () => ({ taskId: 'task-x', contextId: 'ctx-1', state: 'SUBMITTED' as const })),
    GetTask: os.summariseCorpus.GetTask.handler(async () => ({ state: 'SUBMITTED' as const })),
  },
  CancelTask: os.CancelTask.handler(async ({ input }) => {
    rows.set(input.taskId, { state: 'CANCELLED' });
    return { state: 'CANCELLED' as const };
  }),
});

const seen: { header?: string; key?: string; path?: string }[] = [];
const server = createRouterClient(router, { context: { callerId: 'temporal-worker' } });

/** The link takes the LOOSER context; the client's own type is the gate. */
const link: ClientLink<Routed & { idempotencyKey?: string }> = {
  async call(path, input, options) {
    seen.push({
      path: path.join('.'),
      header: options.context.runtimeSessionId, // the AgentCore session header
      key: options.context.idempotencyKey,
    });
    let node: any = server;
    for (const segment of path) node = node[segment];
    return node(input);
  },
};

const client: AgentForgeClient = createORPCClient(link);

// ── run it ─────────────────────────────────────────────────────────────────
console.log('\noRPC — A2A verbs, root-level CancelTask, per-call context\n');

const session = { runtimeSessionId: 'rts-01a0c4eb' };

const handle = await client.reviewStrategy.SendMessage(
  { strategyId: 'alpha', depth: 5 },
  { context: { ...session, idempotencyKey: 'idem-1' } },
);
console.log(`  reviewStrategy.SendMessage ->  ${JSON.stringify(handle)}`);

for (let poll = 0; poll < 5; poll += 1) {
  // No idempotency key here, and none is asked for.
  const task = await client.reviewStrategy.GetTask({ taskId: handle.taskId }, { context: session });
  if (task.state === 'SUCCEEDED') {
    console.log(`  reviewStrategy.GetTask     ->  SUCCEEDED verdict=${task.output.verdict} score=${task.output.score}`);
    break;
  }
  console.log(`  reviewStrategy.GetTask     ->  ${task.state}`);
  await new Promise((r) => setTimeout(r, 10));
}

const cancelled = await client.CancelTask({ taskId: handle.taskId }, { context: session });
console.log(`  CancelTask (root)          ->  ${JSON.stringify(cancelled)}`);

console.log('\n  what the link saw:');
for (const call of seen) {
  console.log(`    ${String(call.path).padEnd(28)} session=${call.header}  key=${call.key ?? '—'}`);
}

// ── type probes: checked by tsc, not at run time ───────────────────────────
async function probes() {
  // @ts-expect-error a start with no idempotency key does not compile
  await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 1 }, { context: session });

  // @ts-expect-error nor with no runtime session to route to
  await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 1 }, { context: { idempotencyKey: 'k' } });

  // @ts-expect-error a poll must still be routed
  await client.reviewStrategy.GetTask({ taskId: 't' }, { context: {} });

  // @ts-expect-error and CancelTask takes a task id, not a procedure's input
  await client.CancelTask({ strategyId: 'a' }, { context: session });

  // A poll needs NO idempotency key — this is the whole point, and it compiles:
  const task = await client.reviewStrategy.GetTask({ taskId: 't' }, { context: session });
  if (task.state === 'SUCCEEDED') {
    const verdict: 'PASS' | 'FAIL' = task.output.verdict;
    void verdict;
  }
  // @ts-expect-error the output is still unreachable before narrowing
  task.output;

  const other = await client.summariseCorpus.GetTask({ taskId: 't' }, { context: session });
  if (other.state === 'SUCCEEDED') {
    // @ts-expect-error each namespace's GetTask carries ITS OWN output type
    const wrong: number = other.output.score;
    void wrong;
  }
}
void probes;
console.log();
