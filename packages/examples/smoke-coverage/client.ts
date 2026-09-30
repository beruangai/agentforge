// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The project client: one client over every agent of smoke-coverage,
// typed by its contract, built once from how each agent is reached.
import {
  type AgentForgeClient,
  agentCoreTransportsFromRuntimeConfig,
  createClient,
  localContainerTransport,
  type RuntimeConfigSource,
  type Transport,
} from '@beruangai/agentforge/client';
import { helloAgent } from './agents/hello-agent/agent/contract.ts';

export const SMOKE_COVERAGE_CONTRACTS = {
  helloAgent,
};

/** Each agent's key in the runtime configuration its construct registers it under. */
export const SMOKE_COVERAGE_RUNTIME_CONFIG_KEYS = {
  helloAgent: 'SmokeCoverageHelloAgent',
} as const;

/** Each agent's local container, as `serve-<agent>` runs it. */
export const SMOKE_COVERAGE_CONTAINER_NAMES = {
  helloAgent: 'beruangai-smoke-coverage-hello-agent',
} as const;

export type SmokeCoverageAgent = keyof typeof SMOKE_COVERAGE_CONTRACTS;

export type SmokeCoverageClient = {
  readonly [Agent in SmokeCoverageAgent]: AgentForgeClient<
    (typeof SMOKE_COVERAGE_CONTRACTS)[Agent]
  >;
};

function withTransports(
  transports: Readonly<Record<SmokeCoverageAgent, Transport>>,
): SmokeCoverageClient {
  return {
    helloAgent: createClient(
      SMOKE_COVERAGE_CONTRACTS.helloAgent,
      transports.helloAgent,
    ),
  };
}

export const smokeCoverageClient = {
  /** Each agent through the transport given for it. */
  withTransports,
  /** Each agent in its local container, found by name. */
  local: (): SmokeCoverageClient =>
    withTransports({
      helloAgent: localContainerTransport(
        SMOKE_COVERAGE_CONTAINER_NAMES.helloAgent,
      ),
    }),
  /** Each agent on AgentCore, resolved from the deployment's runtime configuration. */
  fromRuntimeConfig: async (
    source: RuntimeConfigSource,
  ): Promise<SmokeCoverageClient> =>
    withTransports(
      await agentCoreTransportsFromRuntimeConfig(
        SMOKE_COVERAGE_RUNTIME_CONFIG_KEYS,
        source,
      ),
    ),
};
