/**
 * The kernel's structured output validation (§REQ208) against a real model,
 * through `runAgent`: one PreToolUse entry on the `StructuredOutput`
 * submission refuses structured output the agent contract or a stop guard
 * rejects, and the agent submits again in its turn. AgentForge relies on it, and the SDK documents
 * none of it: that a denied submission is retried in the same run, that the
 * result carries the accepted one, and that the CLI ends a run whose
 * submissions are all refused with `error_max_structured_output_retries`
 * carrying the last refusal (docs/research/claude-agent-sdk.md, 2026-10-01).
 *
 * What is asserted holds whichever way the model words its output.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../../../src/server/harness/kernel.ts';
import {
  createSandbox,
  createSubscriptionEnvironment,
} from '../../__fixtures__/claude-agent-sdk.ts';

const MODEL = 'claude-haiku-4-5';

function sandboxed(name: string) {
  const sandbox = createSandbox(name);
  onTestFinished(() => sandbox.dispose());
  return sandbox;
}

/** A procedure's own PreToolUse hook, before the kernel's: it sees every submission. */
function recordingSubmissions() {
  const submissions: unknown[] = [];
  const hook: HookCallback = async (input) => {
    if (input.hook_event_name === 'PreToolUse') {
      submissions.push(input.tool_input);
    }
    return {};
  };
  return {
    submissions,
    hooks: { PreToolUse: [{ matcher: 'StructuredOutput', hooks: [hook] }] },
  };
}

describe('structured output validation', () => {
  it('refuses what the contract refuses beyond the JSON Schema, and the run returns the accepted structured output', async () => {
    const sandbox = sandboxed('structured-output-validation-contract');
    const AddressSchema = z.object({
      address: z.url().describe('The address the text gives'),
    });
    const recording = recordingSubmissions();
    const run = await runAgent(
      {
        prompt: [
          'Report the address the text gives, copied exactly as it is written there.',
          { tag: 'text', context: 'The guide lives at example.com/guide.' },
        ],
        output: AddressSchema,
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: MODEL,
          settingSources: [],
          tools: [],
          maxTurns: 8,
          hooks: recording.hooks,
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
    );

    expect(AddressSchema.parse(run.output)).toEqual(run.output);
    // Every refused submission was followed by another; the last is the one returned.
    expect(recording.submissions.at(-1)).toEqual(run.output);
    for (const refused of recording.submissions.slice(0, -1)) {
      expect(AddressSchema.safeParse(refused).success).toBe(false);
    }
  });

  it('holds the structured output back until a stop guard passes, in the same run', async () => {
    const sandbox = sandboxed('structured-output-validation-guard');
    const notes = join(sandbox.workingDirectory, 'notes.md');
    const run = await runAgent(
      {
        prompt: 'What is two plus two? Answer in words.',
        output: z.object({ answer: z.string() }),
        guardrails: {
          stop: [
            async () =>
              existsSync(notes) &&
              readFileSync(notes, 'utf8').includes('CHECKED')
                ? undefined
                : {
                    reason:
                      'Write a file named notes.md in your working directory containing the word CHECKED, then submit again.',
                  },
          ],
        },
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: MODEL,
          settingSources: [],
          tools: ['Write'],
          permissionMode: 'acceptEdits',
          maxTurns: 8,
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
    );

    expect(run.output.answer).toEqual(expect.any(String));
    expect(readFileSync(notes, 'utf8')).toContain('CHECKED');
  });

  it('fails OUTPUT_INVALID, carrying the guard’s reason, when no structured output is ever accepted', async () => {
    const sandbox = sandboxed('structured-output-validation-never');
    const promise = runAgent(
      {
        prompt: 'What is two plus two? Answer in words.',
        output: z.object({ answer: z.string() }),
        guardrails: {
          stop: [
            async () => ({
              reason: 'The ledger is closed today; nothing can be accepted.',
            }),
          ],
        },
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: MODEL,
          settingSources: [],
          tools: [],
          maxTurns: 12,
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
    );

    await expect(promise).rejects.toMatchObject({
      taskCause: {
        code: 'OUTPUT_INVALID',
        message: expect.stringMatching(/The ledger is closed today/),
      },
    });
  });
});
