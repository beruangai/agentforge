/**
 * Claude Code's fence on reads outside a run's working directories, through
 * `runAgent` against a real model. AgentForge's claim that one task's agent
 * does not read another's mount, whatever the procedure allows (§REQ403),
 * rests on it: the fence is new in Claude Code, and the docs do not say that
 * a directory added with the SDK's `additionalDirectories` (`--add-dir`)
 * counts as a working directory under it, nor that it overrides an allow
 * rule (docs/research/claude-agent-sdk.md, 2026-10-02).
 *
 * The assertions read the tool calls' outcomes from hooks, which hold
 * whichever way the model words its reply.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
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
const MOUNT_MARKER = 'MOUNT-READ-7F3A';
const SIBLING_MARKER = 'SIBLING-LEAKED-9C2E';

/** A tool call, as attempted, and what it came to: succeeded with its response, failed, or was denied. */
interface ToolOutcome {
  readonly tool: string;
  readonly input: string;
  readonly outcome: 'ATTEMPTED' | 'SUCCEEDED' | 'FAILED' | 'DENIED';
  readonly response: string;
}

function recordingToolOutcomes() {
  const outcomes: ToolOutcome[] = [];
  const record =
    (outcome: ToolOutcome['outcome']): HookCallback =>
    async (input) => {
      if (
        input.hook_event_name === 'PreToolUse' ||
        input.hook_event_name === 'PostToolUse' ||
        input.hook_event_name === 'PostToolUseFailure' ||
        input.hook_event_name === 'PermissionDenied'
      ) {
        outcomes.push({
          tool: input.tool_name,
          input: JSON.stringify(input.tool_input),
          outcome,
          response: JSON.stringify(
            input.hook_event_name === 'PostToolUse'
              ? input.tool_response
              : input,
          ),
        });
      }
      return {};
    };
  return {
    outcomes,
    hooks: {
      PreToolUse: [{ hooks: [record('ATTEMPTED')] }],
      PostToolUse: [{ hooks: [record('SUCCEEDED')] }],
      PostToolUseFailure: [{ hooks: [record('FAILED')] }],
      PermissionDenied: [{ hooks: [record('DENIED')] }],
    },
  };
}

describe('the read fence', () => {
  it('reads a directory given as additionalDirectories, and refuses a sibling an allow rule names, by Read and by cat', async () => {
    const sandbox = createSandbox('read-fence');
    onTestFinished(() => sandbox.dispose());
    const base = realpathSync(join(sandbox.workingDirectory, '..'));
    const mount = join(base, 'mount');
    const sibling = join(base, 'sibling');
    mkdirSync(mount);
    mkdirSync(sibling);
    writeFileSync(join(mount, 'note.txt'), MOUNT_MARKER);
    writeFileSync(join(sibling, 'secret.txt'), SIBLING_MARKER);

    const recording = recordingToolOutcomes();
    await runAgent(
      {
        prompt: [
          'Do each step below, one tool call per step, in order, even if one fails. Then submit `done: true`.',
          `1. Use the Read tool to read ${join(mount, 'note.txt')}`,
          `2. Use the Read tool to read ${join(sibling, 'secret.txt')}`,
          `3. Use the Bash tool to run: cat ${join(sibling, 'secret.txt')}`,
        ].join('\n'),
        output: z.object({ done: z.boolean() }),
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: MODEL,
          settingSources: [],
          tools: ['Read', 'Bash'],
          permissionMode: 'dontAsk',
          additionalDirectories: [mount],
          allowedTools: [`Read(/${sibling}/**)`, 'Bash(cat *)'],
          settings: {
            permissions: { blockReadsOutsideWorkingDirectories: true },
          },
          maxTurns: 12,
          hooks: recording.hooks,
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
    );

    const { outcomes } = recording;
    const naming = (tool: string, path: string) =>
      outcomes.filter(
        (outcome) => outcome.tool === tool && outcome.input.includes(path),
      );
    expect(
      naming('Read', mount).some(
        ({ outcome, response }) =>
          outcome === 'SUCCEEDED' && response.includes(MOUNT_MARKER),
      ),
    ).toBe(true);
    // Each was attempted, and none succeeded: refused, never read.
    for (const tool of ['Read', 'Bash']) {
      const calls = naming(tool, sibling);
      expect(calls.map(({ outcome }) => outcome)).toContain('ATTEMPTED');
      expect(calls.map(({ outcome }) => outcome)).not.toContain('SUCCEEDED');
    }
    for (const { response } of outcomes) {
      expect(response).not.toContain(SIBLING_MARKER);
    }
  });
});
