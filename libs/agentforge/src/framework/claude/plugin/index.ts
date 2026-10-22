import type { ScaffoldedFile } from '../../../plugin/artifacts/maintained.ts';
import type {
  FrameworkPlugin,
  LayerScaffoldContext,
} from '../../../plugin/framework-plugin.ts';
import { REQUIRED_SECRETS } from '../core/secrets.ts';

const CLAUDE_SETTINGS = `${JSON.stringify(
  { $schema: 'https://json.schemastore.org/claude-code-settings.json' },
  null,
  2,
)}\n`;

/** The Claude configuration a layer starts with: settings, and empty `skills/` and `agents/`. */
function claudePlaceholders(directory: string): ScaffoldedFile[] {
  return [
    { path: `${directory}/$claude/settings.json`, content: CLAUDE_SETTINGS },
    { path: `${directory}/$claude/skills/.gitkeep`, content: '' },
    { path: `${directory}/$claude/agents/.gitkeep`, content: '' },
  ];
}

/** The Claude Agent SDK's part of the plugin (ADR 0021). */
export const plugin: FrameworkPlugin = {
  baseScaffolds: ({
    directory,
    projectName,
    basePackageName,
  }: LayerScaffoldContext) => [
    {
      path: `${directory}/options.ts`,
      content: `import type { AgentOptions } from '@beruangai/agentforge/claude/agent';

/**
 * What every agent in ${projectName} runs with, composed under each agent's own
 * options with \`composeOptions\`. An agent's cwd is its own directory, so the
 * \`project\` setting source composes this layer's \`.claude/\` from the parent.
 * Reads outside a run's working directories are refused, so a procedure
 * composes \`context.agentOptions\` — its mounts as \`additionalDirectories\`
 * and their baseline rules — into a run's own; one that must read more turns
 * the fence off in its own options. Agents import it as
 * \`${basePackageName}/options\`.
 */
export function baseOptions(): AgentOptions {
  return {
    settingSources: ['project'],
    settings: { permissions: { blockReadsOutsideWorkingDirectories: true } },
  };
}
`,
    },
    {
      path: `${directory}/$claude/CLAUDE.md`,
      content: `# ${projectName}

What every agent in this project is told. Replace this placeholder.
`,
    },
    ...claudePlaceholders(directory),
  ],
  agentScaffolds: ({ directory }: LayerScaffoldContext) =>
    claudePlaceholders(directory),
  imports: {
    agent: '@beruangai/agentforge/claude/agent',
    server: '@beruangai/agentforge/claude/server',
    infra: '@beruangai/agentforge/claude/infra',
  },
  containerPeers: ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sdk'],
  image: {
    dockerfile: 'claude/Dockerfile',
    containerDirectory: 'claude/container',
  },
  configurationDirectory: { source: '$claude', target: '.claude' },
  requiredSecrets: REQUIRED_SECRETS,
};
