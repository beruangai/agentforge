/**
 * A custom, non-HTTP link carries a typed call, and middleware contributes
 * typed context — recorded in docs/research/procedure-framework.md.
 */
import { describe, expect, it } from 'vitest';
import {
  countMiddlewareRuns,
  createLinkedClient,
} from './__fixtures__/custom-link-and-typed-context.ts';

const containerContext = {
  idempotencyKey: 'idempotency-key-review-strategy-alpha',
  attempt: 3,
};

describe('a custom link over a non-HTTP transport', () => {
  it('hands the link exactly the path and the input, and returns the output across a JSON hop', async () => {
    const { client, wire } = createLinkedClient(containerContext);

    const handle = await client.reviewStrategy.SendMessage({
      strategyId: 'alpha',
      depth: 5,
    });
    const task = await client.reviewStrategy.GetTask({
      taskId: handle.taskId,
    });

    expect(handle).toStrictEqual({
      taskId: 'task-alpha',
      contextId: 'context-task-alpha',
      state: 'TASK_STATE_SUBMITTED',
    });
    expect(task).toStrictEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { verdict: 'PASS', score: 50 },
    });
    expect(wire).toStrictEqual([
      {
        path: ['reviewStrategy', 'SendMessage'],
        input: { strategyId: 'alpha', depth: 5 },
      },
      { path: ['reviewStrategy', 'GetTask'], input: { taskId: 'task-alpha' } },
    ]);
  });
});

describe('middleware-contributed context', () => {
  it('reaches a later middleware and the handler, each contribution intact', async () => {
    const { client, handlerObservations } =
      createLinkedClient(containerContext);

    await client.reviewStrategy.SendMessage({ strategyId: 'alpha', depth: 5 });

    expect(handlerObservations).toStrictEqual([
      {
        idempotencyKey: containerContext.idempotencyKey,
        lease: { holder: 'container-3', generation: 3 },
        // Read off `context.lease` by the second middleware, with no cast.
        audit: { leaseHolder: 'container-3' },
      },
    ]);
  });
});

describe('where a router is assembled', () => {
  it('runs a builder middleware once per call when assembled on the implementer without it', async () => {
    expect(await countMiddlewareRuns()).toBe(1);
  });
});
