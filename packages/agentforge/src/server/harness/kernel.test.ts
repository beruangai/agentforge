import type {
  SDKMessage,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { init, result, scriptedQuery } from './__fixtures__/scripted-query.ts';
import {
  deadToolMatchers,
  matcherSelects,
  type QueryFunction,
  runAgent,
  TaskCanceled,
  TaskFailure,
} from './kernel.ts';

const OutputSchema = z.object({ answer: z.string() });

function run(
  scripted: ReturnType<typeof scriptedQuery>,
  signal = new AbortController().signal,
) {
  const records: unknown[] = [];
  return {
    records,
    promise: runAgent(
      { prompt: 'q', output: OutputSchema, options: { maxTurns: 3 } },
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
    expect(agentRun.record).not.toHaveProperty('prompt');
    expect(agentRun.record.promptHash).toEqual(expect.any(String));
  });

  it('refuses an agent contract whose root is not an object, before the run', async () => {
    const scripted = scriptedQuery([]);
    await expect(
      runAgent(
        { prompt: 'q', output: z.array(z.string()) },
        { signal: new AbortController().signal, onRecord: () => undefined },
        scripted.query,
      ),
    ).rejects.toThrow(/wrapNonObjectOutput/);
    expect(scripted.calls).toHaveLength(0);
  });

  it('sends an opted-in non-object root wrapped, and returns it unwrapped', async () => {
    const scripted = scriptedQuery([
      result({ structured_output: { output: ['a', 'b'] } }),
    ]);
    const agentRun = await runAgent(
      { prompt: 'q', output: z.array(z.string()), wrapNonObjectOutput: true },
      { signal: new AbortController().signal, onRecord: () => undefined },
      scripted.query,
    );
    expect(agentRun.output).toEqual(['a', 'b']);
    expect(scripted.calls[0]?.options.outputFormat).toMatchObject({
      schema: { type: 'object', required: ['output'] },
    });
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

  describe('with a session store', () => {
    const ASSISTANT = {
      type: 'assistant',
      uuid: 'assistant-1',
      session_id: 'session-1',
      message: { role: 'assistant', content: [] },
    } as unknown as SDKMessage;
    const KEY = { projectKey: 'project', sessionId: 'session-1' };

    /** The SDK's mirror, reduced to appending these entries as the run starts. */
    function mirroring(
      scripted: ReturnType<typeof scriptedQuery>,
      entries: SessionStoreEntry[],
    ): QueryFunction {
      return ((parameters: Parameters<QueryFunction>[0]) => {
        void parameters.options?.sessionStore?.append(KEY, entries);
        return scripted.query(parameters);
      }) as QueryFunction;
    }

    function storeOf(appended: SessionStoreEntry[][]): SessionStore {
      return {
        append: async (_key, entries) => {
          appended.push(entries);
        },
        load: async () => null,
      };
    }

    const answered = () =>
      scriptedQuery([
        ASSISTANT,
        result({ structured_output: { answer: 'x' } }),
      ]);
    const ENTRIES = [{ type: 'assistant', uuid: 'assistant-1' }];

    it("mirrors to the deployment's store, unless the procedure names its own", async () => {
      const deployed: SessionStoreEntry[][] = [];
      const own: SessionStoreEntry[][] = [];
      const context = {
        signal: new AbortController().signal,
        onRecord: () => {},
        sessionStore: storeOf(deployed),
      };
      await runAgent(
        { prompt: 'q', output: OutputSchema },
        context,
        mirroring(answered(), ENTRIES),
      );
      expect(deployed).toEqual([ENTRIES]);
      await runAgent(
        {
          prompt: 'q',
          output: OutputSchema,
          options: { sessionStore: storeOf(own) },
        },
        context,
        mirroring(answered(), ENTRIES),
      );
      expect(own).toEqual([ENTRIES]);
      expect(deployed).toHaveLength(1);
    });

    it('fails the run when an assistant message never reached the store', async () => {
      const context = {
        signal: new AbortController().signal,
        onRecord: () => {},
        sessionStore: storeOf([]),
      };
      expect(
        await causeOf(
          runAgent(
            { prompt: 'q', output: OutputSchema },
            context,
            mirroring(answered(), []),
          ),
        ),
      ).toBe('EXECUTION_ERROR');
    });
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

describe('hook matchers', () => {
  it('evaluates a matcher as Claude Code does', () => {
    expect(matcherSelects(undefined, 'Bash')).toBe(true);
    expect(matcherSelects('*', 'Bash')).toBe(true);
    expect(matcherSelects('Edit|Write', 'Write')).toBe(true);
    expect(matcherSelects('Edit, Write', 'Write')).toBe(true);
    // Exact characters only: compared whole, never as a prefix.
    expect(matcherSelects('mcp__memory', 'mcp__memory__create_entities')).toBe(
      false,
    );
    // Any other character: an unanchored regular expression.
    expect(
      matcherSelects('mcp__memory__.*', 'mcp__memory__create_entities'),
    ).toBe(true);
    expect(matcherSelects('Edit.*', 'NotebookEdit')).toBe(true);
  });

  it('names each tool-event matcher that selects no tool', () => {
    const hook = { hooks: [async () => ({})] };
    expect(
      deadToolMatchers(
        {
          PreToolUse: [
            { ...hook, matcher: 'Bash' },
            { ...hook, matcher: 'StructuredOuput' },
          ],
          Stop: [{ ...hook, matcher: 'anything' }],
        },
        ['Bash', 'StructuredOutput'],
      ),
    ).toEqual(['PreToolUse "StructuredOuput"']);
  });

  it('fails the run before its first turn when a guardrail would never fire', async () => {
    const scripted = scriptedQuery([
      init(),
      result({ structured_output: { answer: 'unguarded' } }),
    ]);
    const promise = runAgent(
      {
        prompt: 'q',
        output: OutputSchema,
        options: {
          hooks: {
            PreToolUse: [{ matcher: 'Bash', hooks: [async () => ({})] }],
          },
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
      scripted.query,
    );
    await expect(promise).rejects.toThrow(/PreToolUse "Bash"/);
  });
});
