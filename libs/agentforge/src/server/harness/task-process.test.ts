import { oc } from '@orpc/contract';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contractHash } from '#core/contract/procedures.ts';
import type { RunRecord } from '#core/contract/task.ts';
import type { TaskInvocation } from '#core/task-protocol/messages.ts';
import { TASK_OUTPUT_CAP_BYTES } from '#core/task-table.ts';
import { result, scriptedQuery } from './__fixtures__/scripted-query.ts';
import { executeProcedure, implementAgent } from './task-process.ts';

const contract = {
  summarise: oc.input(z.object({ text: z.string() })).output(
    z.object({
      summary: z.string(),
      words: z.number(),
      sessionId: z.string(),
    }),
  ),
  nested: {
    broken: oc.input(z.object({})).output(z.object({ ok: z.boolean() })),
    failing: oc.input(z.object({})).output(z.object({ ok: z.boolean() })),
  },
  runs: {
    twice: oc.input(z.object({})).output(z.object({ summaries: z.string() })),
    none: oc.input(z.object({})).output(z.object({ ran: z.boolean() })),
    afterCancel: oc.input(z.object({})).output(z.object({ ok: z.boolean() })),
  },
};

/** Called by `runs.afterCancel` between its runs: the test cancels there. */
let betweenRuns: () => void = () => undefined;

const SUMMARY = z.object({ summary: z.string() });

const os = implementAgent(contract);
const router = os.router({
  summarise: os.summarise.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: `Summarise: ${input.text}`,
      output: z.object({ summary: z.string() }),
    });
    return {
      summary: run.output.summary,
      words: run.output.summary.split(' ').length,
      sessionId: run.sessionId,
    };
  }),
  nested: {
    // Returns what the contract refuses.
    broken: os.nested.broken.handler(async () => ({ ok: 'yes' }) as never),
    failing: os.nested.failing.handler(async () => {
      throw new Error('the handler gave up');
    }),
  },
  runs: {
    twice: os.runs.twice.handler(async ({ context }) => {
      const first = await context.runAgent({ prompt: 'one', output: SUMMARY });
      const second = await context.runAgent({
        prompt: ['two', { tag: 'first', context: first.output.summary }],
        output: SUMMARY,
      });
      return {
        summaries: `${first.output.summary} + ${second.output.summary}`,
      };
    }),
    none: os.runs.none.handler(async () => ({ ran: false })),
    afterCancel: os.runs.afterCancel.handler(async ({ context }) => {
      await context.runAgent({ prompt: 'one', output: SUMMARY });
      betweenRuns();
      await context.runAgent({ prompt: 'two', output: SUMMARY });
      return { ok: true };
    }),
  },
});

function invocation(
  overrides: Partial<TaskInvocation['envelope']> = {},
): TaskInvocation {
  return {
    taskId: 't-1',
    contextId: 'c-1',
    runtimeSessionId: 'r-1',
    attempt: 1,
    priorAttempt: undefined,
    envelope: {
      procedure: 'summarise',
      contractHash: contractHash(contract.summarise),
      input: { text: 'a long text' },
      idempotencyKey: 'k-1',
      ...overrides,
    },
  };
}

function execute(
  task: TaskInvocation,
  scripted = scriptedQuery([
    result({ structured_output: { summary: 'short and sweet' } }),
  ]),
  signal = new AbortController().signal,
) {
  return executeProcedure({
    contract,
    router,
    invocation: task,
    signal,
    onRecord: () => undefined,
    query: scripted.query,
  });
}

describe('executeProcedure', () => {
  it('completes with the outer output the procedure computed', async () => {
    expect(await execute(invocation())).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { summary: 'short and sweet', words: 3, sessionId: 'session-1' },
    });
  });

  it('rejects a contract hash it does not serve, before any work', async () => {
    const outcome = await execute(invocation({ contractHash: 'not-this' }));
    expect(outcome.state).toBe('TASK_STATE_REJECTED');
  });

  it('rejects an unknown procedure and malformed input', async () => {
    expect((await execute(invocation({ procedure: 'nope' }))).state).toBe(
      'TASK_STATE_REJECTED',
    );
    expect((await execute(invocation({ input: { text: 3 } }))).state).toBe(
      'TASK_STATE_REJECTED',
    );
  });

  it('carries the kernel’s cause through oRPC', async () => {
    const outcome = await execute(
      invocation(),
      scriptedQuery([result({ subtype: 'error_max_turns', is_error: true })]),
    );
    expect(outcome).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'BUDGET_EXHAUSTED' },
    });
  });

  it('fails an outer output the contract refuses', async () => {
    const outcome = await execute(
      invocation({
        procedure: 'nested.broken',
        contractHash: contractHash(contract.nested.broken),
        input: {},
      }),
    );
    expect(outcome).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'OUTPUT_INVALID',
        message: expect.stringMatching(/at ok/),
        payload: { ok: 'yes' },
      },
    });
  });

  it('fails an output over the cap', async () => {
    const outcome = await execute(
      invocation(),
      scriptedQuery([
        result({
          structured_output: { summary: 'x'.repeat(TASK_OUTPUT_CAP_BYTES) },
        }),
      ]),
    );
    expect(outcome).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'OUTPUT_TOO_LARGE',
        message: expect.stringMatching(`the cap is ${TASK_OUTPUT_CAP_BYTES}`),
      },
    });
  });

  it('drops the payload of a cause over the cap, logging it whole', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const padding = 'x'.repeat(TASK_OUTPUT_CAP_BYTES);
    const outcome = await execute(
      invocation(),
      scriptedQuery([result({ structured_output: { summary: 3, padding } })]),
    );
    expect(outcome).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'OUTPUT_INVALID',
        message: expect.stringMatching(
          new RegExp(
            `payload was dropped: the cause was \\d+ bytes, and the cap is ${TASK_OUTPUT_CAP_BYTES}`,
          ),
        ),
      },
    });
    expect(
      outcome.state === 'TASK_STATE_FAILED' && outcome.cause,
    ).not.toHaveProperty('payload');
    expect(logged).toHaveBeenCalledWith(
      expect.stringMatching(/payload, dropped/),
      JSON.stringify({ summary: 3, padding }),
    );
    logged.mockRestore();
  });

  it('fails with the message of an error the handler throws', async () => {
    const outcome = await execute(
      invocation({
        procedure: 'nested.failing',
        contractHash: contractHash(contract.nested.failing),
        input: {},
      }),
    );
    expect(outcome).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: {
        code: 'EXECUTION_ERROR',
        message: 'Error: the handler gave up',
      },
    });
  });

  it('reports a cancel as cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await execute(invocation(), undefined, controller.signal)).toEqual({
      state: 'TASK_STATE_CANCELED',
    });
  });
});

describe('a procedure’s runs', () => {
  function executeRuns(
    procedure: 'twice' | 'none' | 'afterCancel',
    controller = new AbortController(),
  ) {
    const records: RunRecord[] = [];
    const scripted = scriptedQuery([
      result({ structured_output: { summary: 'short' } }),
    ]);
    const outcome = executeProcedure({
      contract,
      router,
      invocation: invocation({
        procedure: `runs.${procedure}`,
        contractHash: contractHash(contract.runs[procedure]),
        input: {},
      }),
      signal: controller.signal,
      onRecord: (record) => records.push(record),
      query: scripted.query,
    });
    return { outcome, records, scripted };
  }

  it('settles and records each of several runs, and completes with what the procedure returns', async () => {
    const { outcome, records, scripted } = executeRuns('twice');
    expect(await outcome).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { summaries: 'short + short' },
    });
    expect(scripted.calls).toHaveLength(2);
    expect(records).toHaveLength(2);
  });

  it('completes with no run, and no record', async () => {
    const { outcome, records, scripted } = executeRuns('none');
    expect(await outcome).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { ran: false },
    });
    expect(scripted.calls).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it('starts no run after a cancel', async () => {
    const controller = new AbortController();
    betweenRuns = () => controller.abort();
    const { outcome, records, scripted } = executeRuns(
      'afterCancel',
      controller,
    );
    expect(await outcome).toEqual({ state: 'TASK_STATE_CANCELED' });
    expect(scripted.calls).toHaveLength(1);
    expect(records).toHaveLength(1);
    betweenRuns = () => undefined;
  });
});
