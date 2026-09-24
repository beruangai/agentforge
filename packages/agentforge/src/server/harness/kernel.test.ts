import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { init, result, scriptedQuery } from './__fixtures__/scripted-query.ts';
import { runAgent, TaskCanceled, TaskFailure } from './kernel.ts';

const output = z.object({ answer: z.string() });

function run(
  scripted: ReturnType<typeof scriptedQuery>,
  signal = new AbortController().signal,
) {
  const records: unknown[] = [];
  return {
    records,
    promise: runAgent(
      { prompt: 'q', output, options: { maxTurns: 3 } },
      { signal, onRecord: (record) => records.push(record) },
      scripted.query,
    ),
  };
}

async function causeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TaskFailure))
    throw new Error(`expected a TaskFailure, got ${String(error)}`);
  return error.taskCause.code;
}

describe('runAgent', () => {
  it('returns the structured answer, the session id and a record', async () => {
    const scripted = scriptedQuery([
      init('s-42'),
      result({ structured_output: { answer: 'yes' }, session_id: 's-42' }),
    ]);
    const { promise, records } = run(scripted);
    const agentRun = await promise;
    expect(agentRun.output).toEqual({ answer: 'yes' });
    expect(agentRun.sessionId).toBe('s-42');
    expect(records).toHaveLength(1);
    expect(agentRun.record.options).toEqual({ maxTurns: 3 });
  });

  it('switches background work off and sets the output format', async () => {
    const scripted = scriptedQuery([
      result({ structured_output: { answer: 'x' } }),
    ]);
    await run(scripted).promise;
    const options = scripted.calls[0]?.options as {
      env: Record<string, string>;
      outputFormat: { type: string };
    };
    expect(options.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(options.outputFormat.type).toBe('json_schema');
  });

  it('takes the first result and ignores a later one', async () => {
    const scripted = scriptedQuery([
      result({ structured_output: { answer: 'first' } }),
      result({ structured_output: { answer: 'second' } }),
    ]);
    expect((await run(scripted).promise).output).toEqual({ answer: 'first' });
  });

  it.each([
    [
      'success with no structured output',
      result({ structured_output: undefined, result: 'prose' }),
      'OUTPUT_INVALID',
    ],
    [
      'a non-conforming answer',
      result({ structured_output: { answer: 7 } }),
      'OUTPUT_INVALID',
    ],
    [
      'maxTurns',
      result({ subtype: 'error_max_turns', is_error: true }),
      'BUDGET_EXHAUSTED',
    ],
    [
      'maxBudgetUsd',
      result({ subtype: 'error_max_budget_usd', is_error: true }),
      'BUDGET_EXHAUSTED',
    ],
    [
      'a 429',
      result({ is_error: true, api_error_status: 429, result: 'limited' }),
      'USAGE_LIMITED',
    ],
    [
      'a 401',
      result({ is_error: true, api_error_status: 401, result: 'no' }),
      'CREDENTIAL_EXPIRED',
    ],
    [
      'a 529',
      result({ is_error: true, api_error_status: 529, result: 'busy' }),
      'PROVIDER_TRANSIENT',
    ],
    [
      'anything else',
      result({
        subtype: 'error_during_execution',
        is_error: true,
        errors: ['boom'],
      }),
      'EXECUTION_ERROR',
    ],
  ])('classifies %s', async (_name, message, code) => {
    expect(await causeOf(run(scriptedQuery([message])).promise)).toBe(code);
  });

  it('fails when the stream ends with no result', async () => {
    expect(await causeOf(run(scriptedQuery([init()])).promise)).toBe(
      'EXECUTION_ERROR',
    );
  });

  it('interrupts on cancel and reports the task cancelled', async () => {
    const scripted = scriptedQuery([init()], { hang: true });
    const controller = new AbortController();
    const { promise } = run(scripted, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toBeInstanceOf(TaskCanceled);
    expect(scripted.interrupted()).toBe(true);
  });
});
