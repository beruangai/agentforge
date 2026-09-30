import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecutorContext } from '@nx/devkit';
import type { BundleOptions } from '@temporalio/worker';
import type { WorkflowProject } from '../../project-record.ts';
import {
  executorWorkflowProject,
  workspaceConditions,
} from '../executor-project.ts';

/** Where a workflow project's workflow bundle is written, beside the worker bundle. */
export function workflowBundleFile(
  project: Pick<WorkflowProject, 'root'>,
  workspaceRoot: string,
): string {
  return join(workspaceRoot, 'dist', project.root, 'bundle', 'workflows.js');
}

/**
 * What `bundleWorkflowCode` is given: the project's workflow entry, resolved
 * with the workspace's own conditions before webpack's defaults.
 */
export function workflowBundleOptions(
  project: Pick<WorkflowProject, 'root'>,
  workspaceRoot: string,
  conditions: readonly string[],
): Pick<BundleOptions, 'workflowsPath' | 'webpackConfigHook'> {
  return {
    workflowsPath: join(workspaceRoot, project.root, 'workflows', 'index.ts'),
    webpackConfigHook: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        conditionNames: [...conditions, '...'],
      },
    }),
  };
}

/**
 * Bundles the project's workflows with the Temporal SDK the workspace
 * installed, which must be the version the worker runs them with.
 */
export default async function bundleWorkflowsExecutor(
  _options: Record<string, never>,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const project = executorWorkflowProject(context);
  const { bundleWorkflowCode } = await import('@temporalio/worker');
  const { code } = await bundleWorkflowCode(
    workflowBundleOptions(
      project,
      context.root,
      workspaceConditions(context.root),
    ),
  );
  const file = workflowBundleFile(project, context.root);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, code);
  return { success: true };
}
