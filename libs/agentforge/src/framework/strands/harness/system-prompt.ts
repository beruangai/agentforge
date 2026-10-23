import { type SystemContentBlock, TextBlock } from '@strands-agents/sdk';
import type { AgentRunSpec } from './types.ts';

/** Instructions a capability needs the agent to be told, added to a run's system prompt when the run calls for it (ADR 0017). */
export interface SystemPromptFragment {
  /** Names the fragment in errors and logs. */
  readonly name: string;
  /** The fragment's text for this run, or undefined when the run does not call for it. */
  render(spec: AgentRunSpec<unknown>): string | undefined;
}

/** Where the agent works: its mounts, which its file tool reaches by absolute path. */
const WORKING_DIRECTORIES_FRAGMENT: SystemPromptFragment = {
  name: 'working directories',
  render: (spec) => {
    const directories = spec.options?.workingDirectories ?? [];
    if (directories.length === 0) return undefined;
    return `You work in these directories; give the file tool absolute paths within them:\n${directories.map((directory) => `- ${directory}`).join('\n')}`;
  },
};

export const SYSTEM_PROMPT_FRAGMENTS: readonly SystemPromptFragment[] = [
  WORKING_DIRECTORIES_FRAGMENT,
];

/**
 * The run's system prompt: the procedure's own, then each layer's
 * instructions, base first, then every fragment the run calls for, each its
 * own block. None when there is nothing to say.
 */
export function composeSystemPrompt(
  spec: AgentRunSpec<unknown>,
  instructions: readonly string[],
): SystemContentBlock[] | undefined {
  const texts = [
    ...(spec.options?.systemPrompt === undefined
      ? []
      : [spec.options.systemPrompt]),
    ...instructions,
    ...SYSTEM_PROMPT_FRAGMENTS.flatMap((fragment) => {
      const text = fragment.render(spec);
      return text === undefined ? [] : [text];
    }),
  ];
  return texts.length === 0
    ? undefined
    : texts.map((text) => new TextBlock(text));
}
