// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The project client: one client over every agent of research-brief,
// typed by its contract, built once from how each agent is reached.
import {
  type AgentForgeClient,
  agentCoreTransportsFromRuntimeConfig,
  createClient,
  localContainerTransport,
  type RuntimeConfigSource,
  type Transport,
} from '@beruangai/agentforge/client';
import type {
  InferRouterContractInputs,
  InferRouterContractOutputs,
} from '@orpc/contract';
import { contract as briefer } from './agents/briefer/agent/contract.ts';

/** Each agent's contract. */
export const CONTRACTS = {
  briefer,
};

/** Each agent's key in the runtime configuration its construct registers it under. */
export const RUNTIME_CONFIG_KEYS = {
  briefer: 'ResearchBriefBriefer',
} as const;

/** Each agent's local container, as `serve-<agent>` runs it. */
export const CONTAINER_NAMES = {
  briefer: 'beruangai-research-brief-briefer',
} as const;

export type Agent = keyof typeof CONTRACTS;

/** Each procedure's input, by agent and procedure: `Inputs['<agent>']['<Procedure>']`. */
export type Inputs = InferRouterContractInputs<typeof CONTRACTS>;

/** Each procedure's output, by agent and procedure: `Outputs['<agent>']['<Procedure>']`. */
export type Outputs = InferRouterContractOutputs<typeof CONTRACTS>;

export type Client = {
  readonly [Name in Agent]: AgentForgeClient<(typeof CONTRACTS)[Name]>;
};

function withTransports(
  transports: Readonly<Record<Agent, Transport>>,
): Client {
  return {
    briefer: createClient(CONTRACTS.briefer, transports.briefer),
  };
}

/** The research-brief client, built from how each agent is reached. */
export const client = {
  /** Each agent through the transport given for it. */
  withTransports,
  /** Each agent in its local container, found by name. */
  local: (): Client =>
    withTransports({
      briefer: localContainerTransport(CONTAINER_NAMES.briefer),
    }),
  /** Each agent on AgentCore, resolved from the deployment's runtime configuration. */
  fromRuntimeConfig: async (source: RuntimeConfigSource): Promise<Client> =>
    withTransports(
      await agentCoreTransportsFromRuntimeConfig(RUNTIME_CONFIG_KEYS, source),
    ),
};
