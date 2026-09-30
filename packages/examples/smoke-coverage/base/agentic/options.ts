import type { AgentOptions } from '@beruangai/agentforge/agent';

/**
 * What every agent in smoke-coverage runs with, composed under each agent's own
 * options with `composeOptions`: the cheapest model, since the smoke suites
 * assert what AgentForge does around a run, never what the model answers. An
 * agent's cwd is its own directory, so the `project` setting source composes
 * this layer's `.claude/` from the parent.
 */
export function baseOptions(): AgentOptions {
  return { model: 'claude-haiku-4-5', settingSources: ['project'] };
}
