import type { AgentOptions } from '@beruangai/agentforge/agent';

/**
 * What every agent in golden-kata runs with, composed under each agent's own
 * options with `composeOptions`. An agent's cwd is its own directory, so the
 * `project` setting source composes this layer's `.claude/` from the parent.
 * Agents import it as `@beruangai/golden-kata-base/options`.
 */
export function baseOptions(): AgentOptions {
  return { settingSources: ['project'] };
}
