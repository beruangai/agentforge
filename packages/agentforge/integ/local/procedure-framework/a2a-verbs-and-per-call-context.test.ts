/**
 * One contract split into A2A's own task calls — `SendMessage` and `GetTask`
 * per procedure, `CancelTask` once at the root — with the per-call client
 * context enforced per call. Recorded in docs/research/procedure-framework.md
 * and ADR 0013.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { createAgentForgeClient } from './__fixtures__/a2a-verbs-and-per-call-context.ts';
import {
  type TypecheckResult,
  typecheck,
  UNUSED_TS_EXPECT_ERROR_DIRECTIVE,
} from './__fixtures__/typecheck.ts';

const session = { runtimeSessionId: 'runtime-session-01a0c4eb' };

describe('SendMessage, GetTask and CancelTask through the link', () => {
  it('starts, polls through a non-terminal state to the typed output, and cancels at the root', async () => {
    const { client, reviewStrategyTasks, cancelledTaskIds } =
      createAgentForgeClient();

    const handle = await client.reviewStrategy.SendMessage(
      { strategyId: 'alpha', depth: 5 },
      { context: { ...session, idempotencyKey: 'idem-1' } },
    );
    expect(handle).toStrictEqual({
      taskId: expect.any(String),
      contextId: expect.any(String),
      state: 'SUBMITTED',
    });

    const working = await client.reviewStrategy.GetTask(
      { taskId: handle.taskId },
      { context: session },
    );
    expect(working).toStrictEqual({
      state: 'WORKING',
      startedAt: '2026-09-23T00:00:00.000Z',
    });

    reviewStrategyTasks.set(handle.taskId, {
      state: 'SUCCEEDED',
      output: { verdict: 'PASS', score: 50 },
    });
    const succeeded = await client.reviewStrategy.GetTask(
      { taskId: handle.taskId },
      { context: session },
    );
    if (succeeded.state !== 'SUCCEEDED') {
      throw new Error(`expected SUCCEEDED, got ${succeeded.state}`);
    }
    expect(succeeded.output).toStrictEqual({ verdict: 'PASS', score: 50 });

    const cancelled = await client.CancelTask(
      { taskId: handle.taskId },
      { context: session },
    );
    expect(cancelled).toStrictEqual({ state: 'CANCELLED' });
    expect(cancelledTaskIds).toStrictEqual([handle.taskId]);
  });

  it('routes every call by session, and carries the idempotency key on the start alone', async () => {
    const { client, seenByLink } = createAgentForgeClient();

    const handle = await client.reviewStrategy.SendMessage(
      { strategyId: 'alpha', depth: 5 },
      { context: { ...session, idempotencyKey: 'idem-1' } },
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
        idempotencyKey: 'idem-1',
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

describe('types of the split and of the per-call context', () => {
  let result: TypecheckResult;

  beforeAll(() => {
    result = typecheck(
      path.join(
        import.meta.dirname,
        '__fixtures__/a2a-verbs-and-per-call-context.type-probes.ts',
      ),
      {
        fileName: 'a2a-verbs-and-per-call-context.negative-control.ts',
        sourceText: [
          "import { createAgentForgeClient } from './a2a-verbs-and-per-call-context.ts';",
          'export async function negativeControl() {',
          '  const { client } = createAgentForgeClient();',
          '  // @ts-expect-error placed on a valid poll, so it must be reported as unused',
          "  await client.reviewStrategy.GetTask({ taskId: 't' }, { context: { runtimeSessionId: 's' } });",
          '}',
        ].join('\n'),
      },
    );
  });

  it('holds every probe under the project’s strict configuration', () => {
    expect(result.probeDiagnostics).toStrictEqual([]);
  });

  it('reports a directive on a valid line, so the check can fail', () => {
    expect(result.negativeControlDiagnostics).toStrictEqual([
      expect.objectContaining({
        line: 4,
        code: UNUSED_TS_EXPECT_ERROR_DIRECTIVE,
      }),
    ]);
  });
});
