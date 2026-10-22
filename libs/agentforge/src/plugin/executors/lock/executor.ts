import { join } from 'node:path';
import type { ExecutorContext } from '@nx/devkit';
import {
  agentforgeContainerInputs,
  type ContainerInputs,
} from '../../container/container-inputs.ts';
import {
  type ContainerWorkspaceLock,
  lockContainerWorkspace,
} from '../../container/container-workspace.ts';
import { agentOfLayer, frameworkOfLayer } from '../../container/images.ts';
import type { AgenticProject, WorkflowProject } from '../../project-record.ts';
import {
  executorProject,
  executorWorkflowProject,
  runsForWorkflowProject,
} from '../executor-project.ts';

export interface LockExecutorOptions {
  /** `base`, or `agents/<agent>`; `worker`, for a workflow project. */
  readonly layer: string;
}

/**
 * A workflow project's worker lock: the image's manifest, the Temporal
 * packages alone, locked seeded with the workspace's own lock, so every
 * version the workspace installed stays pinned — the worker bundle and the
 * workflow bundle were built with those.
 */
export function workerLock(
  project: Pick<WorkflowProject, 'name' | 'root'>,
  layer: string,
  workspaceRoot: string,
): ContainerWorkspaceLock {
  if (layer !== 'worker') {
    throw new Error(
      `layer "${layer}" is not a workflow project's: ${project.name} locks only its worker`,
    );
  }
  const container = join(workspaceRoot, project.root, 'container');
  return {
    rootManifest: join(container, 'package.json'),
    members: [],
    seed: join(workspaceRoot, 'bun.lock'),
    out: join(container, 'bun.lock'),
  };
}

/**
 * A layer's lock of the container workspace, over the project's framework's
 * root manifest: the base layer's is seeded with the framework's root lock,
 * an agent's with the base layer's, and each is written beside its layer's
 * `package.json`.
 */
export function layerLock(
  project: AgenticProject,
  layer: string,
  inputs: Pick<ContainerInputs, 'packageDirectory' | 'frameworks'>,
  workspaceRoot: string,
): ContainerWorkspaceLock {
  const agentName = agentOfLayer(project, layer);
  if (layer === 'agentforge' || frameworkOfLayer(layer) !== undefined) {
    throw new Error(
      `the ${layer} layer's lock ships in AgentForge's package; lock base or agents/<agent>`,
    );
  }
  const { rootManifest, rootLock } = inputs.frameworks[project.framework];
  const base = join(workspaceRoot, project.root, 'base', 'agentic');
  const members = [
    {
      containerPath: 'agentforge',
      manifest: join(inputs.packageDirectory, 'package.json'),
    },
    { containerPath: 'agentic', manifest: join(base, 'package.json') },
  ] as const;
  if (agentName === undefined) {
    return {
      rootManifest,
      members,
      seed: rootLock,
      out: join(base, 'bun.lock'),
    };
  }
  const agent = join(workspaceRoot, project.root, 'agents', agentName, 'agent');
  return {
    rootManifest,
    members: [
      ...members,
      { containerPath: 'agentic/agent', manifest: join(agent, 'package.json') },
    ],
    seed: join(base, 'bun.lock'),
    out: join(agent, 'bun.lock'),
  };
}

export default async function lockExecutor(
  options: LockExecutorOptions,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  await lockContainerWorkspace(
    runsForWorkflowProject(context)
      ? workerLock(
          executorWorkflowProject(context),
          options.layer,
          context.root,
        )
      : layerLock(
          executorProject(context),
          options.layer,
          agentforgeContainerInputs(),
          context.root,
        ),
  );
  return { success: true };
}
