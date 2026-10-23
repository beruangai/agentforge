import type { StrandsOptions } from '@beruangai/agentforge/strands/agent';

/**
 * What every agent in strands-smoke runs with, composed under each agent's own
 * options with `composeOptions`: the cheapest model, since the smoke suites
 * assert what AgentForge does around a run, never what the model answers. A
 * procedure composes `context.agentOptions` — its mounts as working
 * directories, and the file tool's write scope — into a run's own. Agents
 * import it as `@beruangai/strands-smoke-base/options`.
 */
export function baseOptions(): StrandsOptions {
  return { model: 'claude-haiku-5-5', maxTokens: 4096 };
}
