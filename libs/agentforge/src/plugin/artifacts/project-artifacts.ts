import { isDeepStrictEqual } from 'node:util';
import { formatFilesInSubtree } from '@aws/nx-plugin/sdk/utils/format';
import {
  readJson,
  readProjectConfiguration,
  type TargetConfiguration,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { CONTAINER_ROOT_DEPENDENCIES } from '../container/container-workspace.ts';
import type { AgenticProject, Detached } from '../project-record.ts';
import { agentforgeSpecifier, peerRange } from '../workspace-dependencies.ts';
import {
  agentConstruct,
  constructExports,
  projectConstruct,
  projectConstructsIndex,
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
      projectConstructsIndex(context),
      ...constructExports(context),
      ...sharedConstructsKeys(context),
    ],
    targets: projectTargets(project),
  };
}

/** A project's artifacts as rendered now, with what applying them reads from its record. */
export interface ProjectRendering {
  /** The Nx project's name. */
  readonly name: string;
  readonly detached: Detached;
  readonly artifacts: ProjectArtifacts;
  /** Whether a target AgentForge no longer renders is one it rendered before, and so is removed. */
  readonly isStaleTarget: (
    name: string,
    target: TargetConfiguration,
  ) => boolean;
}

/** An agentic project's rendering: its agents' targets are stale once the agent is not recorded. */
export function agenticProjectRendering(
  tree: Tree,
  project: AgenticProject,
): ProjectRendering {
  return {
    name: project.name,
    detached: project.detached,
    artifacts: projectArtifacts(renderContext(tree, project)),
    isStaleTarget: isAgentTarget,
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
 * and the stale targets removed. A detachment that names nothing maintained
 * throws, naming it.
 */
function applyProjectArtifacts(
  tree: Tree,
  { name, detached, artifacts, isStaleTarget }: ProjectRendering,
): {
  readonly files: readonly Rewritten[];
  readonly targets: readonly string[];
} {
  const maintainedFiles = new Set(artifacts.files.map((file) => file.path));
  const unmaintained = [
    ...detached.files
      .filter((path) => !maintainedFiles.has(path))
      .map((path) => `file ${path}`),
    ...detached.targets
      .filter((target) => artifacts.targets[target] === undefined)
      .map((target) => `target ${target}`),
  ];
  if (unmaintained.length > 0) {
    throw new Error(
      `${name}'s metadata.agentforge.detached names what AgentForge does not maintain: ${unmaintained.join(', ')}`,
    );
  }
  const detachedFiles = new Set(detached.files);
  const detachedTargets = new Set(detached.targets);

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

  const configuration = readProjectConfiguration(tree, name);
  const targets = { ...configuration.targets };
  const changedTargets: string[] = [];
  for (const [targetName, target] of Object.entries(targets)) {
    if (
      artifacts.targets[targetName] === undefined &&
      !detachedTargets.has(targetName) &&
      isStaleTarget(targetName, target)
    ) {
      delete targets[targetName];
      changedTargets.push(`${name}:${targetName}`);
    }
  }
  for (const [targetName, target] of Object.entries(artifacts.targets)) {
    if (
      detachedTargets.has(targetName) ||
      isDeepStrictEqual(targets[targetName], target)
    ) {
      continue;
    }
    targets[targetName] = target;
    changedTargets.push(`${name}:${targetName}`);
  }
  if (changedTargets.length > 0) {
    updateProjectConfiguration(tree, name, { ...configuration, targets });
  }
  return { files, targets: changedTargets };
}

/**
 * Applies every project's rendering and formats what changed, reporting only
 * the files that, once formatted, differ from what they held before — so a
 * file that renders as it already stands is not a change.
 */
export async function applyAndFormat(
  tree: Tree,
  renderings: readonly ProjectRendering[],
): Promise<AppliedChanges> {
  if (!tree.exists(`${SHARED_CONSTRUCTS_DIRECTORY}/project.json`)) {
    throw new Error(
      `${SHARED_CONSTRUCTS_DIRECTORY} does not exist; the agentic-project and workflow-project generators create it`,
    );
  }
  const applied = renderings.map((rendering) =>
    applyProjectArtifacts(tree, rendering),
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
