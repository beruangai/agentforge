import { pascalCase, upperSnakeCase } from '../names.ts';
import { contractName, type RenderContext } from './layers.ts';
import { type MaintainedFile, maintainedHeader } from './maintained.ts';

/**
 * The project client, `<project>/client.ts`: one client over every agent,
 * typed by each agent's contract, composing `createClient` per agent over a
 * transport for each — given, a local container found by name, or an
 * AgentCore runtime resolved from the deployment's runtime configuration.
 */
export function projectClient(context: RenderContext): MaintainedFile {
  const { project } = context;
  const constant = upperSnakeCase(project.projectName);
  const type = pascalCase(project.projectName);
  const client = `${type.charAt(0).toLowerCase()}${type.slice(1)}Client`;
  const { agents } = project;
  const entries = (value: (agent: (typeof agents)[number]) => string) =>
    agents.map((agent) => `  ${contractName(agent)}: ${value(agent)},`);
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
        `import { ${contractName(agent)} } from './agents/${agent.name}/agent/contract.ts';`,
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
        ...contractImports,
        '',
        `export const ${constant}_CONTRACTS = {`,
        ...agents.map((agent) => `  ${contractName(agent)},`),
        '};',
        '',
        `/** Each agent's key in the runtime configuration its construct registers it under. */`,
        `export const ${constant}_RUNTIME_CONFIG_KEYS = {`,
        ...entries((agent) => `'${agent.runtimeConfigKey}'`),
        '} as const;',
        '',
        `/** Each agent's local container, as \`serve-<agent>\` runs it. */`,
        `export const ${constant}_CONTAINER_NAMES = {`,
        ...entries((agent) => `'${agent.containerName}'`),
        '} as const;',
        '',
        `export type ${type}Agent = keyof typeof ${constant}_CONTRACTS;`,
        '',
        `export type ${type}Client = {`,
        `  readonly [Agent in ${type}Agent]: AgentForgeClient<`,
        `    (typeof ${constant}_CONTRACTS)[Agent]`,
        '  >;',
        '};',
        '',
        `function withTransports(`,
        `  ${agents.length > 0 ? '' : '_'}transports: Readonly<Record<${type}Agent, Transport>>,`,
        `): ${type}Client {`,
        '  return {',
        ...entries(
          (agent) =>
            `createClient(${constant}_CONTRACTS.${contractName(agent)}, transports.${contractName(agent)})`,
        ).map((line) => `  ${line}`),
        '  };',
        '}',
        '',
        `export const ${client} = {`,
        '  /** Each agent through the transport given for it. */',
        '  withTransports,',
        '  /** Each agent in its local container, found by name. */',
        `  local: (): ${type}Client =>`,
        '    withTransports({',
        ...entries(
          (agent) =>
            `localContainerTransport(${constant}_CONTAINER_NAMES.${contractName(agent)})`,
        ).map((line) => `    ${line}`),
        '    }),',
        `  /** Each agent on AgentCore, resolved from the deployment's runtime configuration. */`,
        '  fromRuntimeConfig: async (',
        '    source: RuntimeConfigSource,',
        `  ): Promise<${type}Client> =>`,
        '    withTransports(',
        `      await agentCoreTransportsFromRuntimeConfig(${constant}_RUNTIME_CONFIG_KEYS, source),`,
        '    ),',
        '};',
        '',
      ].join('\n'),
  };
}
