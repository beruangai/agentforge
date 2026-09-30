import { agentKey, type RenderContext } from './layers.ts';
import { type MaintainedFile, maintainedHeader } from './maintained.ts';

/**
 * The project client, `<project>/client.ts`: one client over every agent,
 * typed by each agent's contract, composing `createClient` per agent over a
 * transport for each — given, a local container found by name, or an
 * AgentCore runtime resolved from the deployment's runtime configuration.
 * Its exports are generic — `client`, `Client`, `CONTRACTS`, `Inputs`,
 * `Outputs` — and a caller
 * aliases them to the project on import, as this file aliases each agent's
 * `contract`.
 */
export function projectClient(context: RenderContext): MaintainedFile {
  const { project } = context;
  const { agents } = project;
  const entries = (value: (agent: (typeof agents)[number]) => string) =>
    agents.map((agent) => `  ${agentKey(agent)}: ${value(agent)},`);
  const clientImports = [
    'type AgentForgeClient',
    'agentCoreTransportsFromRuntimeConfig',
    ...(agents.length > 0 ? ['createClient', 'localContainerTransport'] : []),
    'type RuntimeConfigSource',
    'type Transport',
  ];
  const contractImports = [...agents]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (agent) =>
        `import { contract as ${agentKey(agent)} } from './agents/${agent.name}/agent/contract.ts';`,
    );
  return {
    path: `${project.root}/client.ts`,
    render: () =>
      [
        maintainedHeader('//'),
        '//',
        `// The project client: one client over every agent of ${project.projectName},`,
        '// typed by its contract, built once from how each agent is reached.',
        'import {',
        ...clientImports.map((name) => `  ${name},`),
        "} from '@beruangai/agentforge/client';",
        'import type {',
        '  InferRouterContractInputs,',
        '  InferRouterContractOutputs,',
        "} from '@orpc/contract';",
        ...contractImports,
        '',
        `/** Each agent's contract. */`,
        'export const CONTRACTS = {',
        ...agents.map((agent) => `  ${agentKey(agent)},`),
        '};',
        '',
        `/** Each agent's key in the runtime configuration its construct registers it under. */`,
        'export const RUNTIME_CONFIG_KEYS = {',
        ...entries((agent) => `'${agent.runtimeConfigKey}'`),
        '} as const;',
        '',
        `/** Each agent's local container, as \`serve-<agent>\` runs it. */`,
        'export const CONTAINER_NAMES = {',
        ...entries((agent) => `'${agent.containerName}'`),
        '} as const;',
        '',
        'export type Agent = keyof typeof CONTRACTS;',
        '',
        "/** Each procedure's input, by agent and procedure: `Inputs['<agent>']['<Procedure>']`. */",
        'export type Inputs = InferRouterContractInputs<typeof CONTRACTS>;',
        '',
        "/** Each procedure's output, by agent and procedure: `Outputs['<agent>']['<Procedure>']`. */",
        'export type Outputs = InferRouterContractOutputs<typeof CONTRACTS>;',
        '',
        'export type Client = {',
        '  readonly [Name in Agent]: AgentForgeClient<(typeof CONTRACTS)[Name]>;',
        '};',
        '',
        `function withTransports(`,
        `  ${agents.length > 0 ? '' : '_'}transports: Readonly<Record<Agent, Transport>>,`,
        '): Client {',
        '  return {',
        ...entries(
          (agent) =>
            `createClient(CONTRACTS.${agentKey(agent)}, transports.${agentKey(agent)})`,
        ).map((line) => `  ${line}`),
        '  };',
        '}',
        '',
        `/** The ${project.projectName} client, built from how each agent is reached. */`,
        'export const client = {',
        '  /** Each agent through the transport given for it. */',
        '  withTransports,',
        '  /** Each agent in its local container, found by name. */',
        '  local: (): Client =>',
        '    withTransports({',
        ...entries(
          (agent) =>
            `localContainerTransport(CONTAINER_NAMES.${agentKey(agent)})`,
        ).map((line) => `    ${line}`),
        '    }),',
        `  /** Each agent on AgentCore, resolved from the deployment's runtime configuration. */`,
        '  fromRuntimeConfig: async (',
        '    source: RuntimeConfigSource,',
        '  ): Promise<Client> =>',
        '    withTransports(',
        '      await agentCoreTransportsFromRuntimeConfig(RUNTIME_CONFIG_KEYS, source),',
        '    ),',
        '};',
        '',
      ].join('\n'),
  };
}
