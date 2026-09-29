/**
 * A turn or budget limit ends the run with an ordinary result, under the
 * kernel's input mode — streaming input, background work off, the input ended
 * on the first result (docs/ARCHITECTURE.md §6).
 *
 * The kernel classifies an outcome from the result — `subtype`,
 * `terminal_reason`, `is_error` — never from an error's text. In
 * single-message mode the SDK yields the limit's result and then throws out of
 * the iterator; whether it also throws in streaming mode once the input has
 * ended is not established, and the kernel catches either way. So each case
 * asserts the result, and records whether draining threw without asserting it.
 *
 * Findings: docs/research/kernel-settlement.md, "E4".
 */
import type { Options, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { BACKGROUND_WORK_DISABLED } from '../../../src/server/harness/kernel.ts';
import { structuredOutputJsonSchema } from '../../../src/server/harness/structured-output.ts';
import {
  createSandbox,
  createSubscriptionEnvironment,
  ProcessOutlivedItsInputError,
  QueryRecording,
  runWithStreamingInput,
} from '../../__fixtures__/claude-agent-sdk.ts';

const OUTPUT_JSON_SCHEMA = structuredOutputJsonSchema(
  z.object({ answer: z.string() }),
);

type Scenario = {
  name: string;
  prompt: string;
  limit: Pick<Options, 'maxTurns' | 'maxBudgetUsd'>;
  expected: Pick<SDKResultMessage, 'subtype' | 'terminal_reason' | 'is_error'>;
};

const echoCommandsOneAtATime = (count: number): string =>
  'Run these Bash commands ONE AT A TIME, never combined, waiting for each: ' +
  Array.from({ length: count }, (_, index) => `\`echo ${index}\``).join(', ') +
  '. Then answer "done".';

const SCENARIOS: Scenario[] = [
  {
    name: 'maxTurns',
    prompt: echoCommandsOneAtATime(8),
    limit: { maxTurns: 2 },
    expected: {
      subtype: 'error_max_turns',
      terminal_reason: 'max_turns',
      is_error: true,
    },
  },
  {
    name: 'maxBudgetUsd',
    prompt: echoCommandsOneAtATime(25),
    limit: { maxBudgetUsd: 0.02, maxTurns: 60 },
    expected: {
      subtype: 'error_max_budget_usd',
      terminal_reason: 'budget_exhausted',
      is_error: true,
    },
  },
];

describe('a turn or budget limit ends the run with a result', () => {
  it.each(SCENARIOS)('$name', async (scenario) => {
    const sandbox = createSandbox(`limits-end-with-a-result-${scenario.name}`);
    onTestFinished(() => sandbox.dispose());
    const recording = new QueryRecording(
      'kernel-settlement',
      `limits-end-with-a-result-${scenario.name}`,
    );

    const drainError = await runWithStreamingInput(recording, scenario.prompt, {
      cwd: sandbox.workingDirectory,
      env: createSubscriptionEnvironment(
        sandbox.configDirectory,
        BACKGROUND_WORK_DISABLED,
      ),
      model: 'claude-sonnet-5',
      allowedTools: ['Bash'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: 'json_schema', schema: OUTPUT_JSON_SCHEMA },
      settingSources: [],
      ...scenario.limit,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    // A process that outlived its input is a failure of its own, not the
    // limit's throw.
    if (drainError instanceof ProcessOutlivedItsInputError) throw drainError;
    recording.appendDrainOutcome(drainError);

    const results = recording.resultMessages();
    const evidence = `results=${JSON.stringify(results.map((result) => [result.subtype, result.terminal_reason]))}; drain threw: ${drainError === undefined ? 'no' : String(drainError)}; see ${recording.logPath}`;
    const [firstResult] = results;
    expect(
      firstResult,
      `the limit ended the run with a result; ${evidence}`,
    ).toBeDefined();
    expect(
      {
        subtype: firstResult?.subtype,
        terminal_reason: firstResult?.terminal_reason,
        is_error: firstResult?.is_error,
      },
      `the first result classifies the limit; ${evidence}`,
    ).toEqual(scenario.expected);
  });
});
