/**
 * One contract split into A2A's own task calls — `SendMessage` and `GetTask`
 * per procedure, `CancelTask` once at the root — with the per-call client
 * context enforced per call. Recorded in docs/research/procedure-framework.md
 * and ADR 0013.
 */
import { describe, expect, it } from 'vitest';
import { createAgentForgeClient } from './__fixtures__/a2a-verbs-and-per-call-context.ts';

const session = { runtimeSessionId: 'runtime-session-01a0c4eb' };
const idempotencyKey = 'idempotency-key-review-strategy-alpha';

describe('SendMessage, GetTask and CancelTask through the link', () => {
  it('starts, polls through a non-terminal state to the typed output, and cancels at the root', async () => {
    const { client, reviewStrategyTasks, cancelledTaskIds } =
      createAgentForgeClient();

    const handle = await client.reviewStrategy.SendMessage(
      { strategyId: 'alpha', depth: 5 },
      { context: { ...session, idempotencyKey } },
    );
    expect(handle).toStrictEqual({
      taskId: expect.any(String),
      contextId: expect.any(String),
      state: 'TASK_STATE_SUBMITTED',
    });

    const working = await client.reviewStrategy.GetTask(
      { taskId: handle.taskId },
      { context: session },
    );
    expect(working).toStrictEqual({
      state: 'TASK_STATE_WORKING',
      startedAt: '2026-09-23T00:00:00.000Z',
    });

    reviewStrategyTasks.set(handle.taskId, {
      state: 'TASK_STATE_COMPLETED',
      output: { verdict: 'PASS', score: 50 },
    });
    const completed = await client.reviewStrategy.GetTask(
      { taskId: handle.taskId },
      { context: session },
    );
    if (completed.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected TASK_STATE_COMPLETED, got ${completed.state}`);
    }
    expect(completed.output).toStrictEqual({ verdict: 'PASS', score: 50 });

    const cancelled = await client.CancelTask(
      { taskId: handle.taskId },
      { context: session },
    );
    expect(cancelled).toStrictEqual({ state: 'TASK_STATE_CANCELED' });
    expect(cancelledTaskIds).toStrictEqual([handle.taskId]);
  });

  it('routes every call by session, and carries the idempotency key on the start alone', async () => {
    const { client, seenByLink } = createAgentForgeClient();

    const handle = await client.reviewStrategy.SendMessage(
      { strategyId: 'alpha', depth: 5 },
      { context: { ...session, idempotencyKey } },
    );
    await client.reviewStrategy.GetTask(
      { taskId: handle.taskId },
      { context: session },
    );
    await client.CancelTask({ taskId: handle.taskId }, { context: session });

    expect(seenByLink).toStrictEqual([
      {
        path: 'reviewStrategy.SendMessage',
        runtimeSessionId: session.runtimeSessionId,
        idempotencyKey,
      },
      {
        path: 'reviewStrategy.GetTask',
        runtimeSessionId: session.runtimeSessionId,
        idempotencyKey: undefined,
      },
      {
        path: 'CancelTask',
        runtimeSessionId: session.runtimeSessionId,
        idempotencyKey: undefined,
      },
    ]);
  });
});
