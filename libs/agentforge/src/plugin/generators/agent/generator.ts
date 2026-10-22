import {
  type GeneratorCallback,
  installPackagesTask,
  type Tree,
} from '@nx/devkit';
import { FRAMEWORK_NAMES } from '#core/contract/framework.ts';
import {
  agenticProjectRendering,
  applyAndFormat,
} from '../../artifacts/project-artifacts.ts';
import { agentScaffolds } from '../../artifacts/scaffolds.ts';
import { KebabNameField, ProcedureNameField, parseName } from '../../names.ts';
import {
  agentComponent,
  appendAgentComponent,
  readAgenticProject,
} from '../../project-record.ts';

export interface AgentGeneratorSchema {
  readonly project: string;
  readonly name: string;
  /** The stub procedure's PascalCase name; `Run` by default. */
  readonly procedure?: string;
}

/**
 * Names no agent may take: the base layer's package is `<project>-base`, and
 * AgentForge's own image targets are `image-agentforge` and
 * `image-agentforge-<framework>`.
 */
const RESERVED_AGENT_NAMES = [
  'base',
  'agentforge',
  ...FRAMEWORK_NAMES.map((framework) => `agentforge-${framework}`),
];

/**
 * An agent as a component of its agentic project: its record, appended once;
 * its scaffolded contract, procedures and framework configuration; and every
 * maintained artifact that spans the project's agents, rendered again from
 * the project's components. Refused, before anything is written, for an
 * unknown or non-agentic project or an invalid name.
 */
export default async function agentGenerator(
  tree: Tree,
  options: AgentGeneratorSchema,
): Promise<GeneratorCallback> {
  const name = parseName(KebabNameField, 'agent name', options.name);
  if (RESERVED_AGENT_NAMES.includes(name)) {
    throw new Error(
      `agent name "${name}" is reserved: ${
        name === 'base'
          ? "the base layer's package takes it"
          : "AgentForge's own image targets take it"
      }`,
    );
  }
  const procedure = parseName(
    ProcedureNameField,
    'procedure name',
    options.procedure ?? 'Run',
  );
  const project = readAgenticProject(tree, options.project);
  const component = agentComponent(project, name);
  appendAgentComponent(tree, project.name, component);
  const updated = readAgenticProject(tree, project.name);
  const recorded = updated.agents.find((agent) => agent.name === name);
  if (recorded === undefined) {
    throw new Error(`${project.name} did not record the agent ${name}`);
  }
  for (const file of agentScaffolds(updated, recorded, procedure)) {
    if (!tree.exists(file.path)) tree.write(file.path, file.content);
  }
  await applyAndFormat(tree, [agenticProjectRendering(tree, updated)]);
  return () => installPackagesTask(tree);
}
