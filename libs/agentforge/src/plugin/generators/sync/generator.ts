import type { Tree } from '@nx/devkit';
import {
  agenticProjectRendering,
  applyAndFormat,
} from '../../artifacts/project-artifacts.ts';
import { workflowProjectRendering } from '../../artifacts/workflow-project.ts';
import {
  readAgenticProjects,
  readWorkflowProjects,
} from '../../project-record.ts';

/** What Nx reads from a sync generator. */
export interface SyncGeneratorResult {
  readonly outOfSyncMessage?: string;
  readonly outOfSyncDetails?: string[];
}

/**
 * Brings every agentic and workflow project's maintained artifacts to what
 * the installed AgentForge renders from its components, except what the
 * consumer detached, and reports each one that differed. Attached to the
 * plugin's lock and image tasks, and run by `nx sync`; `nx sync:check` fails
 * while anything differs.
 */
export default async function syncGenerator(
  tree: Tree,
): Promise<SyncGeneratorResult> {
  const renderings = [
    ...readAgenticProjects(tree).map((project) =>
      agenticProjectRendering(tree, project),
    ),
    ...(await Promise.all(
      readWorkflowProjects(tree).map((project) =>
        workflowProjectRendering(tree, project),
      ),
    )),
  ];
  const changes = await applyAndFormat(tree, renderings);
  const details = [
    ...changes.files.map((path) => `file ${path}`),
    ...changes.targets.map((target) => `target ${target}`),
  ];
  if (details.length === 0) return {};
  return {
    outOfSyncMessage:
      'AgentForge maintains these artifacts, and they differ from what the installed version generates; sync restores them. To keep an edit to one, name it in its project.json metadata.agentforge.detached (files or targets).',
    outOfSyncDetails: details,
  };
}
