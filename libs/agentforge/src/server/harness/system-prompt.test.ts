import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUTO_MEMORY_FRAGMENT } from './auto-memory.ts';
import type { AgentRunSpec } from './kernel.ts';
import { composeSystemPrompt } from './system-prompt.ts';

const MEMORY_DIRECTORY = '/workspace/memories/spaces/a';
const FRAGMENT = AUTO_MEMORY_FRAGMENT.render({
  prompt: 'q',
  output: z.object({}),
  memoryDirectory: MEMORY_DIRECTORY,
}) as string;

function spec(
  systemPrompt: Options['systemPrompt'],
  memoryDirectory?: string,
): AgentRunSpec<unknown> {
  return {
    prompt: 'q',
    output: z.object({}),
    options: systemPrompt === undefined ? {} : { systemPrompt },
    ...(memoryDirectory === undefined ? {} : { memoryDirectory }),
  };
}

describe('composeSystemPrompt', () => {
  it('renders the memory instructions over the declared directory', () => {
    expect(FRAGMENT).toContain(
      `persistent, file-based memory at \`${MEMORY_DIRECTORY}\``,
    );
    expect(FRAGMENT).toContain('MEMORY.md');
  });

  it.each<[string, Options['systemPrompt'], Options['systemPrompt']]>([
    ['absent', undefined, [FRAGMENT]],
    ['a string', 'own', ['own', FRAGMENT]],
    ['a list', ['one', 'two'], ['one', 'two', FRAGMENT]],
    [
      'custom, a string',
      { type: 'custom', prompt: 'own', snapshot: false },
      { type: 'custom', prompt: ['own', FRAGMENT], snapshot: false },
    ],
    [
      'custom, a list',
      { type: 'custom', prompt: ['one', 'two'] },
      { type: 'custom', prompt: ['one', 'two', FRAGMENT] },
    ],
  ])(
    'appends the fragments after a prompt that is %s',
    (_label, own, composed) => {
      expect(composeSystemPrompt(spec(own, MEMORY_DIRECTORY))).toEqual(
        composed,
      );
    },
  );

  it.each<[string, Options['systemPrompt']]>([
    ['absent', undefined],
    ['a string', 'own'],
    ['a list', ['one', 'two']],
    ['custom', { type: 'custom', prompt: 'own' }],
    ['the preset', { type: 'preset', preset: 'claude_code', append: 'more' }],
  ])(
    'passes a prompt that is %s through untouched when no fragment applies',
    (_label, own) => {
      expect(composeSystemPrompt(spec(own))).toBe(own);
    },
  );

  it('refuses the preset when a fragment applies, naming both', () => {
    expect(() =>
      composeSystemPrompt(
        spec({ type: 'preset', preset: 'claude_code' }, MEMORY_DIRECTORY),
      ),
    ).toThrow(
      /AgentForge's "auto-memory" instructions, which the "claude_code" system prompt preset cannot take/,
    );
  });
});
