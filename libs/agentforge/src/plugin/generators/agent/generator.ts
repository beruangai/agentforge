import {
  type GeneratorCallback,
  installPackagesTask,
  type Tree,
} from '@nx/devkit';
import { applyAndFormat } from '../../artifacts/project-artifacts.ts';
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

/** A name no agent may take: the base layer's package is `<project>-base`. */
const RESERVED_AGENT_NAMES = ['base'];

/**
 * An agent as a component of its agentic project: its record, appended once;
 * its scaffolded contract, procedures and Claude configuration; and every
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
      `agent name "${name}" is reserved: the base layer's package takes it`,
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
  await applyAndFormat(tree, [updated]);
  return () => installPackagesTask(tree);
}
