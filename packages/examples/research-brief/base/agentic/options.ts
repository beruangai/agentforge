import type { StrandsOptions } from '@beruangai/agentforge/strands/agent';

/**
 * What every agent in research-brief runs with, composed under each agent's
 * own options with `composeOptions`. A procedure composes
 * `context.agentOptions` — its mounts as working directories, and the file
 * tool's write scope — into a run's own. Agents import it as
 * `@beruangai/research-brief-base/options`.
 */
export function baseOptions(): StrandsOptions {
  return { model: 'claude-sonnet-5-5', maxTokens: 8192 };
}
