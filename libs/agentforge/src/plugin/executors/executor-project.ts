import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorContext, ProjectConfiguration } from '@nx/devkit';
import {
  type AgenticProject,
  agenticProjectOf,
  isAgenticProject,
  isWorkflowProject,
  type WorkflowProject,
  workflowProjectOf,
} from '../project-record.ts';

/** The project an executor runs for, with its package's name. */
function executorConfiguration(context: ExecutorContext): {
  readonly configuration: ProjectConfiguration & { name: string };
  readonly packageName: string;
} {
  const { projectName } = context;
  if (projectName === undefined) {
    throw new Error('the executor runs for no project');
  }
  const configuration = context.projectsConfigurations.projects[projectName];
  if (configuration === undefined) {
    throw new Error(`no project named ${projectName}`);
  }
  const manifest = join(context.root, configuration.root, 'package.json');
  const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    name?: unknown;
  };
  if (typeof name !== 'string') throw new Error(`${manifest} names no package`);
  return {
    configuration: { ...configuration, name: projectName },
    packageName: name,
  };
}

/** The agentic project an executor runs for, read from its record; throws when it is not one. */
export function executorProject(context: ExecutorContext): AgenticProject {
  const { configuration, packageName } = executorConfiguration(context);
  if (!isAgenticProject(configuration)) {
    throw new Error(`${configuration.name} is not an agentic project`);
  }
  return agenticProjectOf(configuration, packageName);
}

/** The workflow project an executor runs for, read from its record; throws when it is not one. */
export function executorWorkflowProject(
  context: ExecutorContext,
): WorkflowProject {
  const { configuration, packageName } = executorConfiguration(context);
  if (!isWorkflowProject(configuration)) {
    throw new Error(`${configuration.name} is not a workflow project`);
  }
  return workflowProjectOf(configuration, packageName);
}

/** Whether the project an executor runs for is a workflow project. */
export function runsForWorkflowProject(context: ExecutorContext): boolean {
  return isWorkflowProject(executorConfiguration(context).configuration);
}

/** The custom conditions the workspace's base tsconfig declares, which its bundlers resolve with too. */
export function workspaceConditions(workspaceRoot: string): string[] {
  const { compilerOptions } = JSON.parse(
    readFileSync(join(workspaceRoot, 'tsconfig.base.json'), 'utf8'),
  ) as { compilerOptions?: { customConditions?: string[] } };
  return compilerOptions?.customConditions ?? [];
}
