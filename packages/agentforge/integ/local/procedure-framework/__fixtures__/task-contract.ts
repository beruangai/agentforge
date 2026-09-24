/**
 * The split under test: one contract in, A2A's own task calls out.
 *
 * **Every AgentForge procedure is really several.** Invocation is asynchronous
 * and `returnImmediately` is always set, so a start returns a handle — whose
 * schema is identical for every procedure — and the caller then polls, and may
 * cancel. End-to-end type safety needs those calls typed per declaration,
 * whatever framework is used; if the type flow breaks at the split, nothing
 * else about oRPC matters.
 *
 * The wire settles the shape. A2A 1.0 has exactly three task RPCs, and
 * `GetTaskRequest` is `{ id, historyLength? }` returning the whole `Task` —
 * status and artifacts, with no artifact filter — so one `GetTask` returning a
 * discriminated union on the state is the honest mapping, not a separate
 * outcome call. `CancelTask` is not the procedure's at all: a task id and a
 * runtime session are the caller's, so it sits once at the root.
 *
 * Namespaces are camelCase; leaf procedures are A2A's verbs, verbatim.
 */
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** What `SendMessage` returns — identical for every procedure, by construction. */
export const taskHandle = z.object({
  taskId: z.string(),
  contextId: z.string(),
  state: z.literal('TASK_STATE_SUBMITTED'),
});

export const taskQuery = z.object({ taskId: z.string() });

/** The typed cause taxonomy of ARCHITECTURE.md §4, abbreviated. */
export const failureCause = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('OUTPUT_INVALID'), payload: z.string() }),
  z.object({ kind: z.literal('LOST') }),
]);

/** A task as `GetTask` answers it: the declared output only where it exists. */
export function taskState<Output extends z.ZodTypeAny>(output: Output) {
  return z.discriminatedUnion('state', [
    z.object({ state: z.literal('TASK_STATE_SUBMITTED') }),
    z.object({ state: z.literal('TASK_STATE_WORKING'), startedAt: z.string() }),
    z.object({ state: z.literal('TASK_STATE_COMPLETED'), output }),
    z.object({ state: z.literal('TASK_STATE_FAILED'), cause: failureCause }),
  ]);
}

/** The utility: one declaration in, the per-procedure calls out. */
export function split<
  Input extends z.ZodTypeAny,
  Output extends z.ZodTypeAny,
>(declaration: { input: Input; output: Output }) {
  return {
    SendMessage: oc.input(declaration.input).output(taskHandle),
    GetTask: oc.input(taskQuery).output(taskState(declaration.output)),
  };
}

export const reviewStrategy = {
  input: z.object({ strategyId: z.string(), depth: z.number() }),
  output: z.object({ verdict: z.enum(['PASS', 'FAIL']), score: z.number() }),
};

export const summariseCorpus = {
  input: z.object({ corpusId: z.string() }),
  output: z.object({ summary: z.string() }),
};

export const contract = {
  reviewStrategy: split(reviewStrategy),
  summariseCorpus: split(summariseCorpus),
  CancelTask: oc.input(taskQuery).output(
    z.object({
      state: z.enum([
        'TASK_STATE_CANCELED',
        'TASK_STATE_COMPLETED',
        'TASK_STATE_FAILED',
      ]),
    }),
  ),
};

export type ReviewStrategyTask = z.infer<
  ReturnType<typeof taskState<typeof reviewStrategy.output>>
>;
