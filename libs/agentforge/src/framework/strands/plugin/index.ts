import type { ScaffoldedFile } from '../../../plugin/artifacts/maintained.ts';
import type {
  FrameworkPlugin,
  LayerScaffoldContext,
} from '../../../plugin/framework-plugin.ts';
import { REQUIRED_SECRETS } from '../core/secrets.ts';

/** The instructions and skills a layer starts with, under Strands' own names. */
function strandsPlaceholders(
  directory: string,
  instructions: string,
): ScaffoldedFile[] {
  return [
    { path: `${directory}/AGENTS.md`, content: instructions },
    { path: `${directory}/.agent/skills/.gitkeep`, content: '' },
  ];
}

/** Strands Agents' part of the plugin (ADR 0021, ADR 0023). */
export const plugin: FrameworkPlugin = {
  baseScaffolds: ({
    directory,
    projectName,
    basePackageName,
  }: LayerScaffoldContext) => [
    {
      path: `${directory}/options.ts`,
      content: `import type { StrandsOptions } from '@beruangai/agentforge/strands/agent';

/**
 * What every agent in ${projectName} runs with, composed under each agent's own
 * options with \`composeOptions\`. Every run names its model. A procedure
 * composes \`context.agentOptions\` — its mounts as working directories, and the
 * file tool's write scope — into a run's own. MCP servers must start, and
 * nothing runs in the background. Agents import it as
 * \`${basePackageName}/options\`.
 */
export function baseOptions(): StrandsOptions {
  return { model: 'claude-sonnet-5-5' };
}
`,
    },
    ...strandsPlaceholders(
      directory,
      `# ${projectName}

What every agent in this project is told. Replace this placeholder.
`,
    ),
  ],
  agentScaffolds: ({ directory }: LayerScaffoldContext) =>
    strandsPlaceholders(
      directory,
      `What this agent is told, after the project's instructions. Replace this placeholder.
`,
    ),
  imports: {
    agent: '@beruangai/agentforge/strands/agent',
    server: '@beruangai/agentforge/strands/server',
    infra: '@beruangai/agentforge/strands/infra',
  },
  containerPeers: [
    '@strands-agents/sdk',
    '@anthropic-ai/sdk',
    '@modelcontextprotocol/client',
    '@cedar-policy/cedar-wasm',
    '@cedar-policy/mcp-schema-generator-wasm',
    '@opentelemetry/api',
    '@opentelemetry/resources',
    '@opentelemetry/sdk-trace-base',
    '@opentelemetry/sdk-metrics',
    '@opentelemetry/exporter-trace-otlp-http',
    '@opentelemetry/exporter-metrics-otlp-http',
  ],
  image: {
    dockerfile: 'strands/Dockerfile',
    containerDirectory: 'strands/container',
  },
  configurationDirectory: { source: '.agent', target: '.agent' },
  requiredSecrets: REQUIRED_SECRETS,
};
