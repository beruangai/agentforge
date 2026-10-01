import type { HookCallback, HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ANSWER_TOOL, answerCheck, type StopGuard } from './answer-check.ts';
import { STRUCTURED_OUTPUT_WRAPPER_KEY } from './structured-output.ts';

const OutputSchema = z.object({
  answer: z.string(),
  source: z.url(),
});

function submit(
  options: {
    readonly output?: z.ZodType;
    readonly wrapped?: boolean;
    readonly guards?: readonly StopGuard[];
    readonly onGuardError?: (error: unknown) => void;
  },
  toolInput: unknown,
) {
  const entry = answerCheck({
    output: options.output ?? OutputSchema,
    wrapped: options.wrapped ?? false,
    guards: options.guards ?? [],
    onGuardError: options.onGuardError ?? (() => undefined),
  });
  expect(entry.matcher).toBe(ANSWER_TOOL);
  const hook = entry.hooks[0] as HookCallback;
  return hook(
    {
      hook_event_name: 'PreToolUse',
      tool_name: ANSWER_TOOL,
      tool_input: toolInput,
      tool_use_id: 'tool-1',
      session_id: 'session-1',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/tmp',
    } as HookInput,
    'tool-1',
    { signal: new AbortController().signal },
  );
}

const VALID = { answer: 'four', source: 'https://example.com/sums' };

function reasonOf(output: unknown): string {
  return (
    output as { hookSpecificOutput: { permissionDecisionReason: string } }
  ).hookSpecificOutput.permissionDecisionReason;
}

describe('answerCheck', () => {
  it('accepts a submission the contract takes and every guard passes', async () => {
    const guard = vi.fn<StopGuard>(async () => undefined);
    expect(await submit({ guards: [guard, guard] }, VALID)).toEqual({});
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it('refuses what the contract refuses beyond the JSON Schema', async () => {
    const output = await submit({}, { ...VALID, source: 'not a url' });
    expect(output).toMatchObject({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
      },
    });
    expect(reasonOf(output)).toMatch(/stricter than the JSON Schema/);
    expect(reasonOf(output)).toMatch(/at source/);
  });

  it('checks a wrapped root as the contract declares it', async () => {
    const wrapped = { output: z.array(z.string()).min(2), wrapped: true };
    expect(
      await submit(wrapped, { [STRUCTURED_OUTPUT_WRAPPER_KEY]: ['a', 'b'] }),
    ).toEqual({});
    expect(
      reasonOf(await submit(wrapped, { [STRUCTURED_OUTPUT_WRAPPER_KEY]: [] })),
    ).toMatch(/>=2 items/);
  });

  it('runs every guard though one denies, and tells every failure in one denial', async () => {
    const later = vi.fn<StopGuard>(async () => ({
      reason: 'Write notes.md before answering.',
    }));
    const output = await submit(
      {
        guards: [
          async () => ({ reason: 'Write kata.md before answering.' }),
          async () => undefined,
          later,
        ],
      },
      { ...VALID, source: 'not a url' },
    );
    expect(later).toHaveBeenCalledOnce();
    const reason = reasonOf(output);
    expect(reason).toMatch(/at source/);
    expect(reason).toMatch(/- Write kata\.md before answering\./);
    expect(reason).toMatch(/- Write notes\.md before answering\./);
    expect(reason.indexOf('at source')).toBeLessThan(reason.indexOf('kata.md'));
  });

  it('hands a guard that throws to the run, never to the agent as a reason', async () => {
    const onGuardError = vi.fn();
    const failure = new Error('the guard broke');
    const output = await submit(
      {
        guards: [
          async () => {
            throw failure;
          },
        ],
        onGuardError,
      },
      VALID,
    );
    expect(onGuardError).toHaveBeenCalledWith(failure);
    expect(reasonOf(output)).not.toMatch(/the guard broke/);
  });

  it('ignores any other event or tool', async () => {
    const entry = answerCheck({
      output: OutputSchema,
      wrapped: false,
      guards: [async () => ({ reason: 'never' })],
      onGuardError: () => undefined,
    });
    const hook = entry.hooks[0] as HookCallback;
    expect(
      await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'Write',
          tool_input: {},
        } as unknown as HookInput,
        'tool-2',
        { signal: new AbortController().signal },
      ),
    ).toEqual({});
  });
});
