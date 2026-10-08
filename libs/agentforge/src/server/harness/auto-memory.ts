import { isAbsolute } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRunSpec } from './kernel.ts';
import type { SystemPromptFragment } from './system-prompt.ts';

/** Turns Claude Code's auto memory off. */
const AUTO_MEMORY_DISABLED_VARIABLE = 'CLAUDE_CODE_DISABLE_AUTO_MEMORY';
/** The settings the kernel owns for a run's memory. */
const AUTO_MEMORY_SETTINGS = ['autoMemoryEnabled', 'autoMemoryDirectory'];

/**
 * Where the run's memory is and how to keep it, verified to make the agent
 * save (docs/research/claude-agent-sdk.md, 2026-10-01). Claude Code's own
 * instructions are in its preset, which AgentForge does not use (ADR 0017).
 */
function autoMemoryInstructions(directory: string): string {
  return `# Memory

You have a persistent, file-based memory at \`${directory}\`. It carries what you learn from one task to later tasks. Its index, \`MEMORY.md\`, is already in your context; read a memory's own file when its index line is relevant to the task.

## When to save
Save a memory when you learn something a later task would need and could not get from its own input or files: a preference or correction you were given, a decision and why it was made, where to find something outside your files. Do not save what the task's input or files already record, or what matters only to this task.

## How to save
Each memory is one Markdown file in \`${directory}\`, holding one fact:

\`\`\`markdown
---
name: <short-kebab-case-slug>
description: <one-line summary, used to decide relevance later>
metadata:
  type: user | feedback | project | reference
---

<the fact; for feedback and project, follow it with **Why:** and **How to apply:** lines>
\`\`\`

Then add one line for it to \`MEMORY.md\`: \`- [Title](file.md) — hook\`. \`MEMORY.md\` is only an index: one line per memory, under 200 lines, never a memory's content.

Before saving, check for a memory that already covers it and update that file instead of adding a duplicate; delete a memory that proves wrong. A memory reflects when it was written: verify one that names a file, path or value before relying on it.`;
}

export const AUTO_MEMORY_FRAGMENT: SystemPromptFragment = {
  name: 'auto-memory',
  render: (spec) =>
    spec.memoryDirectory === undefined
      ? undefined
      : autoMemoryInstructions(spec.memoryDirectory),
};

/**
 * The settings and environment a run's memory declaration calls for: auto
 * memory on in the declared directory, or off (§REQ403, §REQ404). Declaring
 * the directory is the one way to configure it, so a procedure that sets
 * the settings or the variable itself is refused.
 */
export function autoMemoryOptions(
  spec: AgentRunSpec<unknown>,
  inheritedEnv: Readonly<Record<string, string | undefined>>,
): {
  readonly settings: Options['settings'];
  readonly env: Record<string, string | undefined>;
} {
  const { memoryDirectory } = spec;
  const settings = spec.options?.settings;
  if (typeof settings === 'object') {
    for (const key of AUTO_MEMORY_SETTINGS) {
      if (key in settings) {
        throw new Error(
          `the run sets \`${key}\` in its settings: declare \`memoryDirectory\` on the run instead`,
        );
      }
    }
  }
  if (spec.options?.env?.[AUTO_MEMORY_DISABLED_VARIABLE] !== undefined) {
    throw new Error(
      `the run sets ${AUTO_MEMORY_DISABLED_VARIABLE} in its env: auto memory is off unless the run declares \`memoryDirectory\``,
    );
  }
  if (memoryDirectory === undefined) {
    return {
      settings,
      env: { ...inheritedEnv, [AUTO_MEMORY_DISABLED_VARIABLE]: '1' },
    };
  }
  if (!isAbsolute(memoryDirectory)) {
    throw new Error(
      `the run's memoryDirectory is not an absolute directory: "${memoryDirectory}"`,
    );
  }
  if (typeof settings === 'string') {
    throw new Error(
      `the run's settings are the file "${settings}", which its memoryDirectory cannot be added to: give them as an object`,
    );
  }
  // The container's own variable would turn the declared memory off.
  const { [AUTO_MEMORY_DISABLED_VARIABLE]: _disabled, ...env } = inheritedEnv;
  return {
    settings: {
      ...settings,
      autoMemoryEnabled: true,
      autoMemoryDirectory: memoryDirectory,
    },
    env,
  };
}
