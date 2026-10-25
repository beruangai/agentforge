import type { AgentOptions } from '@beruangai/agentforge/claude/agent';

/**
 * What every agent in smoke-coverage runs with, composed under each agent's own
 * options with `composeOptions`: the cheapest model, since the smoke suites
 * assert what AgentForge does around a run, never what the model answers. An
 * agent's cwd is its own directory, so the `project` setting source composes
 * this layer's `.claude/` from the parent; the `user` source loads what the
 * base image installs at Claude's user scope, the `user-scope-probe` plugin.
 * Reads outside a run's working directories are refused, so a procedure
 * gives a run its mounts.
 */
export function baseOptions(): AgentOptions {
  return {
    model: 'claude-haiku-4-5',
    settingSources: ['user', 'project'],
    settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
  };
}
