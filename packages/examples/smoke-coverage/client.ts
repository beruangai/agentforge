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
import { contract as helloAgent } from './agents/hello-agent/agent/contract.ts';

/** Each agent's contract. */
export const CONTRACTS = {
  helloAgent,
};

/** Each agent's key in the runtime configuration its construct registers it under. */
export const RUNTIME_CONFIG_KEYS = {
  helloAgent: 'SmokeCoverageHelloAgent',
} as const;

/** Each agent's local container, as `serve-<agent>` runs it. */
export const CONTAINER_NAMES = {
  helloAgent: 'beruangai-smoke-coverage-hello-agent',
} as const;

export type Agent = keyof typeof CONTRACTS;

export type Client = {
  readonly [Name in Agent]: AgentForgeClient<(typeof CONTRACTS)[Name]>;
};

function withTransports(
  transports: Readonly<Record<Agent, Transport>>,
): Client {
  return {
    helloAgent: createClient(CONTRACTS.helloAgent, transports.helloAgent),
  };
}

/** The smoke-coverage client, built from how each agent is reached. */
export const client = {
  /** Each agent through the transport given for it. */
  withTransports,
  /** Each agent in its local container, found by name. */
  local: (): Client =>
    withTransports({
      helloAgent: localContainerTransport(CONTAINER_NAMES.helloAgent),
    }),
  /** Each agent on AgentCore, resolved from the deployment's runtime configuration. */
  fromRuntimeConfig: async (source: RuntimeConfigSource): Promise<Client> =>
    withTransports(
      await agentCoreTransportsFromRuntimeConfig(RUNTIME_CONFIG_KEYS, source),
    ),
};
