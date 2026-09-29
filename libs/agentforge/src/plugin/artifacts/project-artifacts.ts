import { isDeepStrictEqual } from 'node:util';
import { formatFilesInSubtree } from '@aws/nx-plugin/sdk/utils/format';
import {
  readJson,
  readProjectConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { CONTAINER_ROOT_DEPENDENCIES } from '../container/container-workspace.ts';
import type { AgenticProject } from '../project-record.ts';
import { agentforgeSpecifier, peerRange } from '../workspace-dependencies.ts';
import {
  agentConstruct,
  constructExports,
  projectConstruct,
  SHARED_CONSTRUCTS_DIRECTORY,
  sharedConstructsKeys,
} from './constructs.ts';
import {
  agentDockerfile,
  agentManifest,
  baseDockerfile,
  baseManifest,
  hostManifest,
  projectTsconfig,
  type RenderContext,
  serverEntry,
  taskEntry,
} from './layers.ts';
import { type ProjectArtifacts, readTreeFile } from './maintained.ts';
import { projectClient } from './project-client.ts';
import { isAgentTarget, projectTargets } from './targets.ts';

/** What rendering reads from the workspace, beside the project's record. */
export function renderContext(
  tree: Tree,
  project: AgenticProject,
): RenderContext {
  const root = readJson<{ type?: unknown }>(tree, 'package.json');
  const base = readJson<{ compilerOptions?: { customConditions?: string[] } }>(
    tree,
    'tsconfig.base.json',
  );
  return {
    project,
    agentforgeSpecifier: agentforgeSpecifier(tree),
    runtimePeers: Object.fromEntries(
      CONTAINER_ROOT_DEPENDENCIES.map((name) => [name, peerRange(name)]),
    ),
    esm: root.type === 'module',
    baseConditions: base.compilerOptions?.customConditions ?? [],
  };
}

/** Every artifact AgentForge maintains for a project, rendered from its components. */
export function projectArtifacts(context: RenderContext): ProjectArtifacts {
  const { project } = context;
  return {
    files: [
      hostManifest(context),
      projectTsconfig(context),
      projectClient(context),
      baseDockerfile(project),
      baseManifest(context),
      ...project.agents.flatMap((agent) => [
        agentDockerfile(project, agent),
        agentManifest(context, agent),
        serverEntry(project, agent),
        taskEntry(project, agent),
        agentConstruct(context, agent),
      ]),
      projectConstruct(context),
      ...constructExports(context),
      ...sharedConstructsKeys(context),
    ],
    targets: projectTargets(project),
  };
}

/** What applying a project's artifacts changed: workspace-relative files, and `<project>:<target>`s. */
export interface AppliedChanges {
  readonly files: readonly string[];
  readonly targets: readonly string[];
}

/** A file applying rewrote, with what it held before. */
interface Rewritten {
  readonly path: string;
  readonly previous: string | undefined;
}

/**
 * Brings every maintained, undetached artifact of a project to what this
 * version renders: files rewritten, maintained keys set, targets replaced,
 * and the targets of agents no longer recorded removed. A detachment that
 * names nothing maintained throws, naming it.
 */
function applyProjectArtifacts(
  tree: Tree,
  project: AgenticProject,
): {
  readonly files: readonly Rewritten[];
  readonly targets: readonly string[];
} {
  if (!tree.exists(`${SHARED_CONSTRUCTS_DIRECTORY}/project.json`)) {
    throw new Error(
      `${SHARED_CONSTRUCTS_DIRECTORY} does not exist; the agentic-project generator creates it`,
    );
  }
  const artifacts = projectArtifacts(renderContext(tree, project));
  const maintainedFiles = new Set(artifacts.files.map((file) => file.path));
  const unmaintained = [
    ...project.detached.files
      .filter((path) => !maintainedFiles.has(path))
      .map((path) => `file ${path}`),
    ...project.detached.targets
      .filter((name) => artifacts.targets[name] === undefined)
      .map((name) => `target ${name}`),
  ];
  if (unmaintained.length > 0) {
    throw new Error(
      `${project.name}'s metadata.agentforge.detached names what AgentForge does not maintain: ${unmaintained.join(', ')}`,
    );
  }
  const detachedFiles = new Set(project.detached.files);
  const detachedTargets = new Set(project.detached.targets);

  const files: Rewritten[] = [];
  for (const file of artifacts.files) {
    if (detachedFiles.has(file.path)) continue;
    const current = readTreeFile(tree, file.path);
    const rendered = file.render(current);
    if (rendered !== current) {
      tree.write(file.path, rendered);
      files.push({ path: file.path, previous: current });
    }
  }

  const configuration = readProjectConfiguration(tree, project.name);
  const targets = { ...configuration.targets };
  const changedTargets: string[] = [];
  for (const [name, target] of Object.entries(targets)) {
    if (
      artifacts.targets[name] === undefined &&
      !detachedTargets.has(name) &&
      isAgentTarget(name, target)
    ) {
      delete targets[name];
      changedTargets.push(`${project.name}:${name}`);
    }
  }
  for (const [name, target] of Object.entries(artifacts.targets)) {
    if (detachedTargets.has(name) || isDeepStrictEqual(targets[name], target)) {
      continue;
    }
    targets[name] = target;
    changedTargets.push(`${project.name}:${name}`);
  }
  if (changedTargets.length > 0) {
    updateProjectConfiguration(tree, project.name, {
      ...configuration,
      targets,
    });
  }
  return { files, targets: changedTargets };
}

/**
 * Applies every project's artifacts and formats what changed, reporting only
 * the files that, once formatted, differ from what they held before — so a
 * file that renders as it already stands is not a change.
 */
export async function applyAndFormat(
  tree: Tree,
  projects: readonly AgenticProject[],
): Promise<AppliedChanges> {
  const applied = projects.map((project) =>
    applyProjectArtifacts(tree, project),
  );
  await formatFilesInSubtree(tree);
  const files = new Set<string>();
  for (const { path, previous } of applied.flatMap(
    (changes) => changes.files,
  )) {
    if (readTreeFile(tree, path) !== previous) files.add(path);
  }
  return {
    files: [...files],
    targets: applied.flatMap((changes) => changes.targets),
  };
}
