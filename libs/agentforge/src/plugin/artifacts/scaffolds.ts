import { frameworkPlugin } from '#framework/registry.ts';
import type { AgentComponent, AgenticProject } from '../project-record.ts';
import {
  agentDirectory,
  agentSecretsFile,
  baseDirectory,
  basePackageName,
  baseSecretsFile,
} from './layers.ts';
import type { ScaffoldedFile } from './maintained.ts';

/**
 * A layer's `secrets.ts`: the secrets it requires, by the environment
 * variable each becomes. The agent's construct requires a secret for each,
 * `serve` passes each by name, and the agent's server fails a request while
 * one is unset.
 */
function secretsScaffold(
  project: AgenticProject,
  path: string,
  requiredBy: string,
): ScaffoldedFile {
  const own = frameworkPlugin(project.framework).requiredSecrets.join(', ');
  return {
    path,
    content: `/**
 * The secrets ${requiredBy} requires, by the environment variable each
 * becomes — beside its framework's own, ${own}. The agent's
 * construct requires a secret for each, \`serve\` passes each from
 * .env.serve.local, and the agent's server fails a request while one is unset.
 */
export const REQUIRED_SECRETS = [] as const satisfies readonly string[];
`,
  };
}

/** The base layer's scaffolds: its secrets, and its framework's shared options and configuration. */
export function baseScaffolds(project: AgenticProject): ScaffoldedFile[] {
  return [
    ...frameworkPlugin(project.framework).baseScaffolds({
      directory: `${baseDirectory(project)}/agentic`,
      projectName: project.projectName,
      basePackageName: basePackageName(project),
    }),
    secretsScaffold(
      project,
      baseSecretsFile(project),
      `every agent in ${project.projectName}`,
    ),
  ];
}

/**
 * An agent's scaffolds: its contract with one stub procedure, the
 * procedure's handler failing its task until implemented, its secrets and
 * its framework's configuration.
 */
export function agentScaffolds(
  project: AgenticProject,
  agent: AgentComponent,
  procedure: string,
): ScaffoldedFile[] {
  const directory = `${agentDirectory(project, agent)}/agent`;
  const framework = frameworkPlugin(project.framework);
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
      content: `import { implementAgent } from '${framework.imports.agent}';
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
      project,
      agentSecretsFile(project, agent),
      `the ${agent.name} agent`,
    ),
    ...framework.agentScaffolds({
      directory,
      projectName: project.projectName,
      basePackageName: basePackageName(project),
    }),
  ];
}
