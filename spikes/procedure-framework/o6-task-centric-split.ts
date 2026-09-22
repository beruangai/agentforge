/**
 * THE SPLIT, CORRECTED — three procedures, not two.
 *
 * o1 split a contract into `submit` + `result`. That was wrong in two ways the
 * operator identified:
 *
 *   1. A caller polling a task needs its NON-TERMINAL state, not just a settled
 *      outcome. An activity heartbeating on WORKING has nothing to read from a
 *      procedure that only answers when finished.
 *   2. Cancellation had nowhere to live.
 *
 * The wire settles the shape. A2A 1.0 has exactly three task RPCs, and
 * `GetTaskRequest` is `{ id, historyLength? }` returning the whole `Task` —
 * status AND artifacts, with **no artifact filter**. So a separate `outcome`
 * procedure would be a second name over one call returning identical bytes.
 * One `status` returning a DISCRIMINATED UNION is the honest mapping.
 *
 *   SendMessage  -> create   procedure-typed input, task handle out
 *   GetTask      -> status   task id in, discriminated union on state out
 *   CancelTask   -> cancel   NOT procedure-typed: same shape for every procedure
 *
 * What must hold: narrowing on `state` flows through the link, so a caller that
 * checks for SUCCEEDED gets the declared output typed, and cannot reach it
 * while the task is still WORKING.
 *
 * Run: bun procedure-framework/o6-task-centric-split.ts
 */
import { oc } from '@orpc/contract';
import { implement, createRouterClient } from '@orpc/server';
import { createORPCClient } from '@orpc/client';
import type { ContractRouterClient } from '@orpc/contract';
import type { ClientLink } from '@orpc/client';
import { z } from 'zod';

// ── the shapes every procedure shares ──────────────────────────────────────
const taskHandle = z.object({
  taskId: z.string(),
  contextId: z.string(),
  state: z.literal('SUBMITTED'),
});
const taskQuery = z.object({ taskId: z.string() });

/** The typed cause taxonomy of ARCHITECTURE.md §4, abbreviated. */
const failureCause = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('OUTPUT_INVALID'), payload: z.string() }),
  z.object({ kind: z.literal('TIMED_OUT') }),
  z.object({ kind: z.literal('LOST') }),
]);

/**
 * The split utility. One contract in, three procedures out — `cancel` is not
 * typed by the procedure, because its input is a task id and its output a task
 * state, identically for every procedure.
 */
function split<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(c: { input: I; output: O }) {
  return {
    create: oc.input(c.input).output(taskHandle),
    status: oc.input(taskQuery).output(
      z.discriminatedUnion('state', [
        z.object({ state: z.literal('SUBMITTED') }),
        z.object({ state: z.literal('WORKING'), startedAt: z.string() }),
        z.object({ state: z.literal('SUCCEEDED'), output: c.output }),
        z.object({ state: z.literal('FAILED'), cause: failureCause }),
        z.object({ state: z.literal('CANCELLED'), byThisCaller: z.boolean() }),
      ]),
    ),
    cancel: oc.input(taskQuery).output(z.object({ state: z.enum(['CANCELLED', 'SUCCEEDED', 'FAILED']) })),
  };
}

const contract = {
  reviewStrategy: split({
    input: z.object({ strategyId: z.string(), depth: z.number() }),
    output: z.object({ verdict: z.enum(['PASS', 'FAIL']), score: z.number() }),
  }),
  summariseCorpus: split({
    input: z.object({ corpusId: z.string() }),
    output: z.object({ summary: z.string(), documentCount: z.number() }),
  }),
};

// ── the server ─────────────────────────────────────────────────────────────
const os = implement(contract).$context<{ callerId: string }>();

type Row = { state: string; output?: unknown; startedAt?: string };
const tasks = new Map<string, Row>();
let next = 0;

const router = os.router({
  reviewStrategy: {
    create: os.reviewStrategy.create.handler(async ({ input }) => {
      const taskId = `task-${++next}`;
      tasks.set(taskId, { state: 'WORKING', startedAt: new Date().toISOString() });
      setTimeout(
        () => tasks.set(taskId, { state: 'SUCCEEDED', output: { verdict: input.depth > 2 ? 'PASS' : 'FAIL', score: input.depth * 10 } }),
        30,
      );
      return { taskId, contextId: 'ctx-1', state: 'SUBMITTED' as const };
    }),
    status: os.reviewStrategy.status.handler(async ({ input }) => {
      const row = tasks.get(input.taskId);
      if (!row) throw new Error(`no such task: ${input.taskId}`);
      return row as any;
    }),
    cancel: os.reviewStrategy.cancel.handler(async ({ input }) => {
      tasks.set(input.taskId, { state: 'CANCELLED' });
      return { state: 'CANCELLED' as const };
    }),
  },
  summariseCorpus: {
    create: os.summariseCorpus.create.handler(async () => ({ taskId: 'task-x', contextId: 'ctx-1', state: 'SUBMITTED' as const })),
    status: os.summariseCorpus.status.handler(async () => ({ state: 'SUBMITTED' as const })),
    cancel: os.summariseCorpus.cancel.handler(async () => ({ state: 'CANCELLED' as const })),
  },
});

// ── the link ───────────────────────────────────────────────────────────────
type CallerContext = { idempotencyKey: string };
const server = createRouterClient(router, { context: { callerId: 'temporal-worker' } });

const link: ClientLink<CallerContext> = {
  async call(path, input, options) {
    void options.context.idempotencyKey;
    let node: any = server;
    for (const segment of path) node = node[segment];
    return node(input);
  },
};
const client: ContractRouterClient<typeof contract, CallerContext> = createORPCClient(link);

// ── run it ─────────────────────────────────────────────────────────────────
console.log('\noRPC — create / status / cancel, and narrowing through the link\n');

const context = { idempotencyKey: 'idem-1' };
const handle = await client.reviewStrategy.create({ strategyId: 'alpha', depth: 5 }, { context });
console.log(`  create ->  ${JSON.stringify(handle)}`);

for (let poll = 0; poll < 6; poll += 1) {
  const task = await client.reviewStrategy.status({ taskId: handle.taskId }, { context });
  // The narrowing the caller actually writes. `task.output` is unreachable
  // above this branch, and typed inside it.
  if (task.state === 'SUCCEEDED') {
    const verdict: 'PASS' | 'FAIL' = task.output.verdict;
    const score: number = task.output.score;
    console.log(`  status ->  SUCCEEDED  verdict=${verdict} score=${score}`);
    break;
  }
  if (task.state === 'FAILED') {
    console.log(`  status ->  FAILED     cause=${task.cause.kind}`);
    break;
  }
  console.log(`  status ->  ${task.state}${task.state === 'WORKING' ? `   (since ${task.startedAt})` : ''}`);
  await new Promise((r) => setTimeout(r, 12));
}

const cancelled = await client.reviewStrategy.cancel({ taskId: handle.taskId }, { context });
console.log(`  cancel ->  ${JSON.stringify(cancelled)}`);

// ── type probes: checked by tsc, not at run time ───────────────────────────
async function probes() {
  const h = await client.reviewStrategy.create({ strategyId: 'a', depth: 1 }, { context });
  const task = await client.reviewStrategy.status({ taskId: h.taskId }, { context });

  // @ts-expect-error the output is unreachable before narrowing: a task may still be WORKING
  task.output;

  if (task.state === 'SUCCEEDED') {
    const ok: { verdict: 'PASS' | 'FAIL'; score: number } = task.output;
    // @ts-expect-error and a failure's cause is not on the success branch
    task.cause;
    void ok;
  }

  const other = await client.summariseCorpus.status({ taskId: 't' }, { context });
  if (other.state === 'SUCCEEDED') {
    const summary: string = other.output.summary;
    // @ts-expect-error each procedure's status is typed with ITS OWN output, not a shared one
    const wrong: 'PASS' | 'FAIL' = other.output.verdict;
    void summary; void wrong;
  }

  // @ts-expect-error cancel is not procedure-typed, so it takes a task id and nothing else
  await client.reviewStrategy.cancel({ strategyId: 'a' }, { context });

  // @ts-expect-error the handle is not the outcome
  h.output;
}
void probes;
console.log();
