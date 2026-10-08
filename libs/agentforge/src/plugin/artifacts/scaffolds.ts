import type { AgentComponent, AgenticProject } from '../project-record.ts';
import {
  agentDirectory,
  agentSecretsFile,
  baseDirectory,
  basePackageName,
  baseSecretsFile,
} from './layers.ts';
import type { ScaffoldedFile } from './maintained.ts';

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

/**
 * A layer's `secrets.ts`: the secrets it requires, by the environment
 * variable each becomes. The agent's construct requires a secret for each,
 * `serve` passes each by name, and the agent's server fails a request while
 * one is unset.
 */
function secretsScaffold(path: string, requiredBy: string): ScaffoldedFile {
  return {
    path,
    content: `/**
 * The secrets ${requiredBy} requires, by the environment variable each
 * becomes — beside AgentForge's own, CLAUDE_CODE_OAUTH_TOKEN. The agent's
 * construct requires a secret for each, \`serve\` passes each from
 * .env.serve.local, and the agent's server fails a request while one is unset.
 */
export const REQUIRED_SECRETS = [] as const satisfies readonly string[];
`,
  };
}

/** The base layer's scaffolds: its shared options, its secrets and its Claude configuration. */
export function baseScaffolds(project: AgenticProject): ScaffoldedFile[] {
  const agentic = `${baseDirectory(project)}/agentic`;
  return [
    {
      path: `${agentic}/options.ts`,
      content: `import type { AgentOptions } from '@beruangai/agentforge/agent';

/**
 * What every agent in ${project.projectName} runs with, composed under each agent's own
 * options with \`composeOptions\`. An agent's cwd is its own directory, so the
 * \`project\` setting source composes this layer's \`.claude/\` from the parent.
 * Reads outside a run's working directories are refused, so a procedure
 * composes \`context.agentOptions\` — its mounts as \`additionalDirectories\`
 * and their baseline rules — into a run's own; one that must read more turns
 * the fence off in its own options. Agents import it as
 * \`${basePackageName(project)}/options\`.
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
      path: `${agentic}/$claude/CLAUDE.md`,
      content: `# ${project.projectName}

What every agent in this project is told. Replace this placeholder.
`,
    },
    secretsScaffold(
      baseSecretsFile(project),
      `every agent in ${project.projectName}`,
    ),
    ...claudePlaceholders(agentic),
  ];
}

/**
 * An agent's scaffolds: its contract with one stub procedure, the
 * procedure's handler failing its task until implemented, its secrets and
 * its Claude configuration.
 */
export function agentScaffolds(
  project: AgenticProject,
  agent: AgentComponent,
  procedure: string,
): ScaffoldedFile[] {
  const directory = `${agentDirectory(project, agent)}/agent`;
  return [
    {
      path: `${directory}/contract.ts`,
      content: `import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** What callers import to call the ${agent.name} agent. */
export const contract = {
  ${procedure}: oc
    .meta(timeBudget(300))
    .input(z.strictObject({}))
    .output(z.strictObject({})),
};
`,
    },
    {
      path: `${directory}/procedures.ts`,
      content: `import { implementAgent } from '@beruangai/agentforge/agent';
import { contract } from './contract.ts';

const os = implementAgent(contract);

/**
 * The ${agent.name} agent's procedures. A handler runs the agent with
 * \`context.runAgent\`, its options composed over the base layer's:
 * \`composeOptions(baseOptions(), { … })\`, with \`baseOptions\` from
 * \`${basePackageName(project)}/options\`.
 */
export const router = os.router({
  ${procedure}: os.${procedure}.handler(async () => {
    throw new Error('not implemented: ${agent.name}.${procedure}');
  }),
});
`,
    },
    secretsScaffold(
      agentSecretsFile(project, agent),
      `the ${agent.name} agent`,
    ),
    ...claudePlaceholders(directory),
  ];
}
