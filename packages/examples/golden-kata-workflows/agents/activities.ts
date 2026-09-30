// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The worker's side of the connections: every procedure of every connected
// agentic project's agents as an activity, `<project>.<agent>.<Procedure>`,
// over that project's client — each agent in its local container or on
// AgentCore, as AGENTFORGE_AGENTS names.
import {
  agentsFromEnvironment,
  type ProjectActivity,
  projectActivities,
} from '@beruangai/agentforge/temporal';
import {
  CONTRACTS as GOLDEN_KATA_CONTRACTS,
  client as goldenKataClient,
} from '@beruangai/golden-kata/client';

/**
 * Every connected agent's procedures, as the worker registers them, each
 * over its project's client for where AGENTFORGE_AGENTS says the agents are.
 */
export async function resolveAgentActivities(): Promise<
  Readonly<Record<string, ProjectActivity>>
> {
  const agents = agentsFromEnvironment();
  return {
    ...projectActivities(
      'goldenKata',
      GOLDEN_KATA_CONTRACTS,
      agents.kind === 'local'
        ? goldenKataClient.local()
        : await goldenKataClient.fromRuntimeConfig(agents),
    ),
  };
}
