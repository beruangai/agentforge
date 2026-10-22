import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { AUTO_MEMORY_FRAGMENT } from './auto-memory.ts';
import type { AgentRunSpec } from './kernel.ts';

/** Instructions a capability needs the agent to be told, added to a run's system prompt when the run calls for it (ADR 0017). */
export interface SystemPromptFragment {
  /** Names the fragment in errors and logs. */
  readonly name: string;
  /** The fragment's text for this run, or undefined when the run does not call for it. */
  render(spec: AgentRunSpec<unknown>): string | undefined;
}

export const SYSTEM_PROMPT_FRAGMENTS: readonly SystemPromptFragment[] = [
  AUTO_MEMORY_FRAGMENT,
];

/**
 * The procedure's system prompt with every fragment the run calls for
 * appended, each its own block; untouched when none applies. Refuses the
 * `claude_code` preset when one applies: the preset carries instructions of
 * its own for the same things.
 */
export function composeSystemPrompt(
  spec: AgentRunSpec<unknown>,
): Options['systemPrompt'] {
  const own = spec.options?.systemPrompt;
  const applying = SYSTEM_PROMPT_FRAGMENTS.flatMap((fragment) => {
    const text = fragment.render(spec);
    return text === undefined ? [] : [{ name: fragment.name, text }];
  });
  if (applying.length === 0) return own;
  const texts = applying.map(({ text }) => text);
  if (own === undefined) return texts;
  if (typeof own === 'string') return [own, ...texts];
  if (Array.isArray(own)) return [...own, ...texts];
  if (own.type === 'custom') {
    return {
      ...own,
      prompt: [
        ...(typeof own.prompt === 'string' ? [own.prompt] : own.prompt),
        ...texts,
      ],
    };
  }
  throw new Error(
    `the run calls for AgentForge's ${applying.map(({ name }) => `"${name}"`).join(', ')} instructions, which the "${own.preset}" system prompt preset cannot take: give the run a system prompt of its own (ADR 0017)`,
  );
}
