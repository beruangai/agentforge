/**
 * Does oRPC's contract-first model express AgentForge's actual shape?
 *
 * The crux, and the reason this spike exists: **every AgentForge procedure is
 * really two.** Invocation is asynchronous and `returnImmediately` is always
 * set, so the submit call returns a handle, never an outcome — which means the
 * submit-side output schema is IDENTICAL for every procedure, and a second,
 * separately typed call fetches the result. End-to-end type safety therefore
 * needs a start/fetch pair per declaration, whatever framework is used.
 *
 * So the question is not "is oRPC nice" but: can ONE agentic contract
 * (input -> outcome) be split by a utility into TWO typed procedures, with the
 * types flowing end to end through a custom transport? If the type flow breaks
 * at the split, nothing else about oRPC matters.
 *
 * Nothing here talks to AWS or a model. The link stands in for
 * InvokeAgentRuntime with an in-memory hop, which is enough to prove the seam.
 *
 * Run: bun procedure-framework/o1-contract-split.ts
 */
import { oc } from '@orpc/contract';
import { implement, call } from '@orpc/server';
import { z } from 'zod';

// ── what a consumer declares: ONE contract, input to outcome ────────────────
const agentic = {
  reviewStrategy: {
    input: z.object({ strategyId: z.string(), depth: z.number().int() }),
    output: z.object({ verdict: z.enum(['PASS', 'FAIL']), notes: z.string(), reviewedAt: z.string() }),
  },
  summariseCorpus: {
    input: z.object({ corpusId: z.string() }),
    output: z.object({ summary: z.string(), documentCount: z.number() }),
  },
} as const;

/** What a submit call returns — identical for every procedure, by construction. */
const taskHandle = z.object({ taskId: z.string(), contextId: z.string(), state: z.literal('SUBMITTED') });
/** What a fetch call takes. */
const taskQuery = z.object({ taskId: z.string() });

/**
 * The utility under test: one agentic contract in, two typed procedures out.
 * `submit` takes the procedure's own input and returns the common handle;
 * `result` takes a handle and returns the procedure's OWN output type.
 */
function split<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(c: { input: I; output: O }) {
  return {
    submit: oc.input(c.input).output(taskHandle),
    result: oc.input(taskQuery).output(c.output),
  };
}

const contract = {
  reviewStrategy: split(agentic.reviewStrategy),
  summariseCorpus: split(agentic.summariseCorpus),
};

// ── the runtime side: a store standing in for the task record ───────────────
const store = new Map<string, unknown>();
let counter = 0;

const os = implement(contract).$context<{ callerId: string; attempt: number }>();

const router = os.router({
  reviewStrategy: {
    submit: os.reviewStrategy.submit.handler(async ({ input, context }) => {
      const taskId = `task-${++counter}`;
      // The executor would spawn here and return once the process is STARTED.
      store.set(taskId, { verdict: input.depth > 2 ? 'PASS' : 'FAIL', notes: `${input.strategyId} by ${context.callerId}`, reviewedAt: new Date().toISOString() });
      return { taskId, contextId: `ctx-${taskId}`, state: 'SUBMITTED' as const };
    }),
    result: os.reviewStrategy.result.handler(async ({ input }) => store.get(input.taskId) as any),
  },
  summariseCorpus: {
    submit: os.summariseCorpus.submit.handler(async ({ input }) => {
      const taskId = `task-${++counter}`;
      store.set(taskId, { summary: `summary of ${input.corpusId}`, documentCount: 7 });
      return { taskId, contextId: `ctx-${taskId}`, state: 'SUBMITTED' as const };
    }),
    result: os.summariseCorpus.result.handler(async ({ input }) => store.get(input.taskId) as any),
  },
});

console.log('\noRPC v2 contract-first — does the start/fetch split hold?\n');

const context = { callerId: 'spike', attempt: 1 };
const handle = await call(router.reviewStrategy.submit, { strategyId: 'alpha', depth: 5 }, { context });
console.log('  submit  ->', JSON.stringify(handle));
const outcome = await call(router.reviewStrategy.result, { taskId: handle.taskId }, { context });
console.log('  result  ->', JSON.stringify(outcome));

// ── do the TYPES actually flow? ────────────────────────────────────────────
// These are checked by `tsc`, not at run time. Each must be an error; if any
// stops erroring, the split has lost its typing and the whole idea fails.
async function typeProbes() {
  // @ts-expect-error submit rejects an input field the contract does not have
  await call(router.reviewStrategy.submit, { strategyId: 'a', depth: 1, bogus: true }, { context });
  // @ts-expect-error submit rejects a wrong field type
  await call(router.reviewStrategy.submit, { strategyId: 'a', depth: 'deep' }, { context });
  const r = await call(router.reviewStrategy.result, { taskId: 't' }, { context });
  // @ts-expect-error the result is the procedure's OWN output, not the other procedure's
  const wrong: string = r.summary;
  // @ts-expect-error the handle is not the outcome
  const alsoWrong: string = (await call(router.summariseCorpus.submit, { corpusId: 'c' }, { context })).summary;
  const right: 'PASS' | 'FAIL' = r.verdict;
  const count: number = (await call(router.summariseCorpus.result, { taskId: 't' }, { context })).documentCount;
  void wrong; void alsoWrong; void right; void count;
}
void typeProbes;
console.log('\n  run `bunx tsc --noEmit` to check the type probes\n');
