/**
 * A custom, non-HTTP link carries a typed call, and middleware contributes
 * typed context — recorded in docs/research/procedure-framework.md.
 */
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  countMiddlewareRuns,
  createLinkedClient,
} from './__fixtures__/custom-link-and-typed-context.ts';
import {
  type TypecheckResult,
  typecheck,
  UNUSED_TS_EXPECT_ERROR_DIRECTIVE,
} from './__fixtures__/typecheck.ts';

describe('a custom link over a non-HTTP transport', () => {
  it('hands the link exactly the path and the input, and returns the output across a JSON hop', async () => {
    const { client, wire } = createLinkedClient({
      idempotencyKey: 'idem-1',
      attempt: 3,
    });

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
      state: 'SUBMITTED',
    });
    expect(task).toStrictEqual({
      state: 'SUCCEEDED',
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
    const { client, handlerObservations } = createLinkedClient({
      idempotencyKey: 'idem-1',
      attempt: 3,
    });

    await client.reviewStrategy.SendMessage({ strategyId: 'alpha', depth: 5 });

    expect(handlerObservations).toStrictEqual([
      {
        idempotencyKey: 'idem-1',
        lease: { holder: 'container-3', generation: 3 },
        // Read off `context.lease` by the second middleware, with no cast.
        audit: { leaseHolder: 'container-3' },
      },
    ]);
  });
});

describe('where a router is assembled', () => {
  it('runs a builder middleware once per call when assembled on the implementer without it', async () => {
    expect(await countMiddlewareRuns('BASE_IMPLEMENTER')).toBe(1);
  });

  it('runs it twice per call when assembled on the builder that carries it — oRPC does not deduplicate', async () => {
    expect(await countMiddlewareRuns('MIDDLEWARED_IMPLEMENTER')).toBe(2);
  });
});

describe('types through the link and the middleware chain', () => {
  let result: TypecheckResult;

  beforeAll(() => {
    result = typecheck(
      path.join(
        import.meta.dirname,
        '__fixtures__/custom-link-and-typed-context.type-probes.ts',
      ),
      {
        fileName: 'custom-link-and-typed-context.negative-control.ts',
        sourceText: [
          "import { createLinkedClient } from './custom-link-and-typed-context.ts';",
          'export async function negativeControl() {',
          "  const { client } = createLinkedClient({ idempotencyKey: 'k', attempt: 1 });",
          '  // @ts-expect-error placed on a valid call, so it must be reported as unused',
          "  await client.reviewStrategy.SendMessage({ strategyId: 'a', depth: 1 });",
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
