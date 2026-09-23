// biome-ignore-all format: a @ts-expect-error covers only the line after it, so reflowing a probe would move its error off that line
/**
 * Type probes, checked by `tsc` from `a2a-verbs-and-per-call-context.test.ts`.
 * Each `@ts-expect-error` must still be an error; one that stops erroring is
 * reported as unused and fails the check.
 */
import { expectTypeOf } from 'vitest';
import { createAgentForgeClient } from './a2a-verbs-and-per-call-context.ts';

const session = { runtimeSessionId: 'session' };

/** Per-call context: the key on a start alone, the session on every call. */
export async function perCallContextProbes() {
  const { client } = createAgentForgeClient();

  // @ts-expect-error a start with no idempotency key does not compile
  await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 1 }, { context: session });
  // @ts-expect-error nor with no runtime session to route to
  await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 1 }, { context: { idempotencyKey: 'k' } });
  // @ts-expect-error a poll must still be routed
  await client.reviewStrategy.GetTask({ taskId: 't' }, { context: {} });
  // @ts-expect-error and CancelTask takes a task id, not a procedure's input
  await client.CancelTask({ strategyId: 'a' }, { context: session });

  // A poll needs NO idempotency key — the whole point — and it compiles.
  await client.reviewStrategy.GetTask({ taskId: 't' }, { context: session });
  await client.CancelTask({ taskId: 't' }, { context: session });
}

/** `GetTask`'s union narrows through the link, per procedure. */
export async function getTaskNarrowingProbes() {
  const { client } = createAgentForgeClient();

  const handle = await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 1 }, { context: { ...session, idempotencyKey: 'k' } });
  // @ts-expect-error the handle is not the outcome
  void handle.output;

  const task = await client.reviewStrategy.GetTask({ taskId: handle.taskId }, { context: session });
  // @ts-expect-error the output is unreachable before narrowing: a task may still be WORKING
  void task.output;
  if (task.state === 'SUCCEEDED') {
    expectTypeOf(task.output).toEqualTypeOf<{ verdict: 'PASS' | 'FAIL'; score: number }>();
    // @ts-expect-error and a failure's cause is not on the success branch
    void task.cause;
  }
  if (task.state === 'FAILED') {
    expectTypeOf(task.cause.kind).toEqualTypeOf<'OUTPUT_INVALID' | 'LOST'>();
  }
  if (task.state === 'WORKING') {
    expectTypeOf(task.startedAt).toEqualTypeOf<string>();
  }

  const other = await client.summariseCorpus.GetTask({ taskId: 't' }, { context: session });
  if (other.state === 'SUCCEEDED') {
    expectTypeOf(other.output).toEqualTypeOf<{ summary: string }>();
    // @ts-expect-error each namespace's GetTask carries ITS OWN output type, not a shared one
    void other.output.score;
  }
}
