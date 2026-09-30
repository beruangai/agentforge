import { spawnSync } from 'node:child_process';
import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutorContext } from '@nx/devkit';
import type { WorkflowProject } from '../../project-record.ts';
import {
  executorWorkflowProject,
  workspaceConditions,
} from '../executor-project.ts';

/** The worker image's build context, beside the worker bundle: the container's files. */
export const STAGED_FILES = ['Dockerfile', 'package.json', 'bun.lock'] as const;

export interface WorkerBuild {
  /** `bun` and its arguments. */
  readonly args: readonly string[];
  /** The build context: the bundle's directory. */
  readonly directory: string;
  /** Each container file, from the project to the build context. */
  readonly staged: readonly { readonly from: string; readonly to: string }[];
}

/**
 * The worker's build: `worker.ts` bundled for Node with every Temporal
 * package left external — the core bridge is native, and the activity
 * context must be the one copy the worker loads — resolved with the
 * workspace's conditions and the project's tsconfig, whose `paths` map each
 * connected project's base layer; and the image's files staged beside it.
 */
export function workerBuild(
  project: Pick<WorkflowProject, 'root'>,
  workspaceRoot: string,
  conditions: readonly string[],
): WorkerBuild {
  const root = join(workspaceRoot, project.root);
  const directory = join(workspaceRoot, 'dist', project.root, 'bundle');
  return {
    args: [
      'build',
      join(root, 'worker.ts'),
      '--target=node',
      '--format=esm',
      '--external=@temporalio/*',
      `--tsconfig-override=${join(root, 'tsconfig.lib.json')}`,
      ...conditions.map((condition) => `--conditions=${condition}`),
      `--outfile=${join(directory, 'worker.mjs')}`,
    ],
    directory,
    staged: STAGED_FILES.map((file) => ({
      from: join(root, 'container', file),
      to: join(directory, file),
    })),
  };
}

export default async function bundleWorkerExecutor(
  _options: Record<string, never>,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const build = workerBuild(
    executorWorkflowProject(context),
    context.root,
    workspaceConditions(context.root),
  );
  await mkdir(build.directory, { recursive: true });
  const bundled = spawnSync('bun', build.args, {
    cwd: context.root,
    stdio: 'inherit',
  });
  if (bundled.error !== undefined) throw bundled.error;
  if (bundled.status !== 0) {
    throw new Error(
      `bun ${build.args.join(' ')} exited ${bundled.status ?? bundled.signal}`,
    );
  }
  for (const { from, to } of build.staged) await copyFile(from, to);
  return { success: true };
}
