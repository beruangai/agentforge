// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
//
// The project client: one client over every agent of golden-kata,
// typed by its contract, built once from how each agent is reached.
import {
  type AgentForgeClient,
  agentCoreTransportsFromRuntimeConfig,
  createClient,
  localContainerTransport,
  type RuntimeConfigSource,
  type Transport,
} from '@beruangai/agentforge/client';
import { grader } from './agents/grader/agent/contract.ts';
import { writer } from './agents/writer/agent/contract.ts';

export const GOLDEN_KATA_CONTRACTS = {
  writer,
  grader,
};

/** Each agent's key in the runtime configuration its construct registers it under. */
export const GOLDEN_KATA_RUNTIME_CONFIG_KEYS = {
  writer: 'GoldenKataWriter',
  grader: 'GoldenKataGrader',
} as const;

/** Each agent's local container, as `serve-<agent>` runs it. */
export const GOLDEN_KATA_CONTAINER_NAMES = {
  writer: 'beruangai-golden-kata-writer',
  grader: 'beruangai-golden-kata-grader',
} as const;

export type GoldenKataAgent = keyof typeof GOLDEN_KATA_CONTRACTS;

export type GoldenKataClient = {
  readonly [Agent in GoldenKataAgent]: AgentForgeClient<
    (typeof GOLDEN_KATA_CONTRACTS)[Agent]
  >;
};

function withTransports(
  transports: Readonly<Record<GoldenKataAgent, Transport>>,
): GoldenKataClient {
  return {
    writer: createClient(GOLDEN_KATA_CONTRACTS.writer, transports.writer),
    grader: createClient(GOLDEN_KATA_CONTRACTS.grader, transports.grader),
  };
}

export const goldenKataClient = {
  /** Each agent through the transport given for it. */
  withTransports,
  /** Each agent in its local container, found by name. */
  local: (): GoldenKataClient =>
    withTransports({
      writer: localContainerTransport(GOLDEN_KATA_CONTAINER_NAMES.writer),
      grader: localContainerTransport(GOLDEN_KATA_CONTAINER_NAMES.grader),
    }),
  /** Each agent on AgentCore, resolved from the deployment's runtime configuration. */
  fromRuntimeConfig: async (
    source: RuntimeConfigSource,
  ): Promise<GoldenKataClient> =>
    withTransports(
      await agentCoreTransportsFromRuntimeConfig(
        GOLDEN_KATA_RUNTIME_CONFIG_KEYS,
        source,
      ),
    ),
};
