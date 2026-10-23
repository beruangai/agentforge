import { z } from 'zod';
import type { RunRecord } from '#core/contract/task.ts';
import { TaskFailure } from '../../../../server/harness/task-failure.ts';
import {
  type RunnerContext,
  runAgent,
  STRUCTURED_OUTPUT_TOOL,
} from '../runner.ts';
import type { AgentRunSpec } from '../types.ts';
import type { ScriptedAnthropic, ScriptedStep } from './scripted-anthropic.ts';

export const AnswerSchema = z.object({ answer: z.string() });

/** The scripted model submitting `input` as its structured output. */
export const submit = (input: unknown): ScriptedStep => ({
  toolCalls: [{ name: STRUCTURED_OUTPUT_TOOL, input }],
});

/** A run against the scripted API: prompt `q`, the answer contract, a model named, no retries. */
export function runScripted<Output = { answer: string }>(
  api: ScriptedAnthropic,
  spec: Partial<AgentRunSpec<Output>> = {},
  /** A key given as `undefined` takes the runner's default: `retryStrategy`, the SDK's retries. */
  context: {
    readonly [Key in keyof RunnerContext]?: RunnerContext[Key] | undefined;
  } = {},
  signal = new AbortController().signal,
) {
  const records: RunRecord[] = [];
  const promise = runAgent(
    {
      prompt: 'q',
      output: AnswerSchema as unknown as z.ZodType<Output>,
      options: { model: 'claude-test', maxTokens: 1024 },
      ...spec,
    } as AgentRunSpec<Output>,
    { signal, onRecord: (record) => records.push(record) },
    Object.fromEntries(
      Object.entries({
        apiKey: 'test-key',
        layers: [],
        clientConfig: api.clientConfig,
        retryStrategy: null,
        ...context,
      }).filter(([, value]) => value !== undefined),
    ) as unknown as RunnerContext,
  );
  return { records, promise };
}

/** The cause a run failed with; throws when it did not fail. */
export async function failureOf(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof TaskFailure)) {
    throw new Error(`expected a TaskFailure, got ${String(error)}`);
  }
  return error.taskCause;
}
