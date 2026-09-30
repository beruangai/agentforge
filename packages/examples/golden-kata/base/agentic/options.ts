import type { AgentOptions } from '@beruangai/agentforge/agent';
import { kataServer, RUN_CASES_TOOL } from './kata-server.ts';

/**
 * What every agent in golden-kata runs with, composed under each agent's own
 * options with `composeOptions`. An agent's cwd is its own directory, so the
 * `project` setting source composes this layer's `.claude/` — `CLAUDE.md` and
 * the `kata-style` skill — from the parent. The kata's `directory` is added,
 * so reading it needs no approval; the `kata` server runs it. Anything else
 * that would ask is denied. Agents import it as
 * `@beruangai/golden-kata-base/options`.
 */
export function baseOptions(directory: string): AgentOptions {
  return {
    model: 'claude-haiku-4-5',
    settingSources: ['project'],
    additionalDirectories: [directory],
    mcpServers: { kata: kataServer(directory) },
    tools: ['Read', 'Glob', 'Grep', 'Skill'],
    allowedTools: ['Skill', RUN_CASES_TOOL],
    permissionMode: 'dontAsk',
  };
}
