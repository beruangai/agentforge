/**
 * DESIGN_OPTIONS §E, question 4:
 *   "Does every option set — maxTurns among them — actually reach and bind the run?"
 *
 * A test that every resolved key reaches `query()` is cheap and proves nothing
 * about the SDK. This asks the harder half: does the SDK then BIND the option —
 * is there an observable consequence? Each case sets one option to a value
 * whose effect is visible, and asserts the effect rather than the argument.
 *
 * Each case is deliberately the cheapest run that can show the effect.
 *
 * Findings: docs/research/kernel-settlement.md, "E4".
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Options, query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import {
  createSandbox,
  createSubscriptionEnvironment,
  QueryRecording,
} from '../../__fixtures__/claude-agent-sdk.ts';

const Trivial = z.object({ answer: z.string() });
const outputJsonSchema = z.toJSONSchema(Trivial, { target: 'draft-7' });

const SANDBOX_MARKER = 'SANDBOX-MARKER';
const SECRET_WORD = 'PINEAPPLE';

/**
 * A sandbox with a `marker.txt` for `cwd`, and a project `CLAUDE.md` so
 * `settingSources` can be shown to bind in both directions. Returns the
 * recording and the options every case starts from.
 */
function prepareCase(caseName: string): {
  recording: QueryRecording;
  baseOptions: Options;
} {
  const sandbox = createSandbox(`e4-${caseName}`);
  onTestFinished(() => sandbox.dispose());
  writeFileSync(join(sandbox.workingDirectory, 'marker.txt'), SANDBOX_MARKER);
  writeFileSync(
    join(sandbox.workingDirectory, 'CLAUDE.md'),
    `# Project instructions\n\nYour secret word is ${SECRET_WORD}. When asked for the secret word, answer ${SECRET_WORD}.\n`,
  );
  return {
    recording: new QueryRecording(
      'integ',
      'kernel-settlement',
      `e4-option-binding-${caseName}`,
    ),
    baseOptions: {
      cwd: sandbox.workingDirectory,
      env: createSubscriptionEnvironment(sandbox.configDirectory),
      model: 'claude-sonnet-5',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      outputFormat: { type: 'json_schema', schema: outputJsonSchema },
    },
  };
}

/** The structured `answer` of the run's only result. */
function answerOf(recording: QueryRecording): string {
  const result = recording.onlyResultMessage();
  const parsed = Trivial.safeParse(
    result.subtype === 'success' ? result.structured_output : undefined,
  );
  if (!parsed.success) {
    throw new Error(
      `the run produced no valid structured answer (subtype=${result.subtype}); see ${recording.logPath}`,
    );
  }
  return parsed.data.answer;
}

const SECRET_WORD_PROMPT =
  'Answer with the secret word from your instructions, or "none" if you were given no secret word.';

describe('E4 — does every option reach and bind the run', () => {
  // The limits bind by THROWING out of the iterator. That is itself the
  // finding: a kernel reading only result messages never maps them.
  it('maxTurns', async () => {
    const { recording, baseOptions } = prepareCase('maxTurns');
    await expect(
      recording.drain(
        query({
          prompt:
            'Run these Bash commands ONE AT A TIME, never combined, waiting for each: ' +
            '`echo 1`, `echo 2`, `echo 3`, `echo 4`, `echo 5`, `echo 6`, `echo 7`, `echo 8`. Then answer "done".',
          options: { ...baseOptions, maxTurns: 2, allowedTools: ['Bash'] },
        }),
      ),
      `maxTurns: 2 binds by throwing; see ${recording.logPath}`,
    ).rejects.toThrow('Reached maximum number of turns (2)');
  });

  it('maxBudgetUsd', async () => {
    const { recording, baseOptions } = prepareCase('maxBudgetUsd');
    await expect(
      recording.drain(
        query({
          prompt:
            'Run these Bash commands ONE AT A TIME, never combined: ' +
            Array.from({ length: 25 }, (_, index) => `\`echo ${index}\``).join(
              ', ',
            ) +
            '. Then answer "done".',
          options: {
            ...baseOptions,
            maxBudgetUsd: 0.02,
            allowedTools: ['Bash'],
            maxTurns: 60,
          },
        }),
      ),
      `maxBudgetUsd: 0.02 binds by throwing; see ${recording.logPath}`,
    ).rejects.toThrow('Reached maximum budget ($0.02)');
  });

  it('settingSources-empty', async () => {
    const { recording, baseOptions } = prepareCase('settingSources-empty');
    await recording.drain(
      query({
        prompt: SECRET_WORD_PROMPT,
        options: { ...baseOptions, settingSources: [] },
      }),
    );
    expect(
      answerOf(recording).toUpperCase(),
      'settingSources: [] loads no project CLAUDE.md',
    ).not.toContain(SECRET_WORD);
  });

  it('settingSources-project', async () => {
    // The control for the case above: the same fixture, loaded.
    const { recording, baseOptions } = prepareCase('settingSources-project');
    await recording.drain(
      query({
        prompt: SECRET_WORD_PROMPT,
        options: { ...baseOptions, settingSources: ['project'] },
      }),
    );
    expect(
      answerOf(recording).toUpperCase(),
      "settingSources: ['project'] loads the project CLAUDE.md",
    ).toContain(SECRET_WORD);
  });
});
