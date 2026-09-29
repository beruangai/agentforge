import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecutorContext } from '@nx/devkit';
import {
  type AgenticProject,
  agenticProjectOf,
  isAgenticProject,
} from '../project-record.ts';

/** The agentic project an executor runs for, read from its record; throws when it is not one. */
export function executorProject(context: ExecutorContext): AgenticProject {
  const { projectName } = context;
  if (projectName === undefined) {
    throw new Error('the executor runs for no project');
  }
  const configuration = context.projectsConfigurations.projects[projectName];
  if (configuration === undefined) {
    throw new Error(`no project named ${projectName}`);
  }
  if (!isAgenticProject(configuration)) {
    throw new Error(`${projectName} is not an agentic project`);
  }
  const manifest = join(context.root, configuration.root, 'package.json');
  const { name } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    name?: unknown;
  };
  if (typeof name !== 'string') throw new Error(`${manifest} names no package`);
  return agenticProjectOf({ ...configuration, name: projectName }, name);
}
