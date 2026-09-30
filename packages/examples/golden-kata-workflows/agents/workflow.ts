// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The workflow side of the connections: each connected agentic project's
// agents as calls typed by their contracts — imported as types only, so the
// workflow bundle carries none of their code.
import { proxyAgenticProject } from '@beruangai/agentforge/temporal/workflow';
import type { CONTRACTS as GOLDEN_KATA_CONTRACTS } from '@beruangai/golden-kata/client';
import type { ActivityOptions } from '@temporalio/workflow';

/**
 * Each connected project's agents, `agents().<project>.<agent>.<Procedure>(input,
 * { runtimeSessionId })`; `options` merge over AgentForge's defaults.
 */
export const agents = (options?: ActivityOptions) => ({
  goldenKata: proxyAgenticProject<typeof GOLDEN_KATA_CONTRACTS>(
    'goldenKata',
    options,
  ),
});
