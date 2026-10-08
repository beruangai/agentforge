import {
  type GeneratorCallback,
  installPackagesTask,
  type Tree,
} from '@nx/devkit';
import { applyAndFormat } from '../../artifacts/project-artifacts.ts';
import { workflowProjectRendering } from '../../artifacts/workflow-project.ts';
import {
  appendConnectionComponent,
  connectionComponent,
  readAgenticProject,
  readWorkflowProject,
} from '../../project-record.ts';

export interface ConnectionGeneratorSchema {
  /** The workflow project that calls. */
  readonly project: string;
  /** The agentic project whose agents it calls. */
  readonly agenticProject: string;
}

/**
 * Connects a workflow project to an agentic project: the connection's
 * record, appended once to the workflow project, and every maintained
 * artifact spanning its connections rendered again from its records.
 * Refused, before anything is written, from anything but a workflow project
 * or to anything but an agentic project.
 */
export default async function connectionGenerator(
  tree: Tree,
  options: ConnectionGeneratorSchema,
): Promise<GeneratorCallback> {
  const project = readWorkflowProject(tree, options.project);
  const agenticProject = readAgenticProject(tree, options.agenticProject);
  appendConnectionComponent(
    tree,
    project.name,
    connectionComponent(project, agenticProject),
  );
  const updated = readWorkflowProject(tree, project.name);
  await applyAndFormat(tree, [await workflowProjectRendering(tree, updated)]);
  // The connection adds a workspace dependency to the workflow project's own
  // manifest, not the root's, which Nx alone would not install: the link to
  // the agentic project would be missing until the next install.
  return () => installPackagesTask(tree, true);
}
