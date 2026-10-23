import { readJson, type Tree, writeJson } from '@nx/devkit';
import picomatch from 'picomatch';
import {
  type AgenticProject,
  readAgenticProjects,
  readWorkflowProjects,
  type WorkflowProject,
} from './project-record.ts';

const ROOT_MANIFEST = 'package.json';

/** The directories of a project's layer manifests, each locked into its own `bun.lock` by the project's `lock` target. */
function layerManifestDirectories(
  project:
    | { readonly kind: 'agentic'; readonly project: AgenticProject }
    | { readonly kind: 'workflow'; readonly project: WorkflowProject },
): string[] {
  if (project.kind === 'workflow') return [`${project.project.root}/container`];
  const { root, agents } = project.project;
  return [
    `${root}/base/agentic`,
    ...agents.map((agent) => `${root}/${agent.path}/agent`),
  ];
}

/** The negation that keeps one project's layer manifests out, in the form AgentForge writes. */
function exclusionOf(kind: 'agentic' | 'workflow', root: string): string {
  return kind === 'agentic'
    ? `!${root}/{agents,base}/**`
    : `!${root}/container`;
}

/** The project root a negation in AgentForge's form names, or undefined for any other entry. */
function excludedRoot(entry: string): string | undefined {
  return /^!(.+)\/(?:\{agents,base\}\/\*\*|container)$/.exec(entry)?.[1];
}

/**
 * Keeps every project's layer manifests out of the root manifest's Bun
 * workspaces, whatever globs the root uses (§REQ709): a project whose layer a
 * root glob would make a member gets AgentForge's negation for it, appended.
 * With `removeStale`, as sync runs it, a negation in that form whose
 * project's `project.json` is gone is removed; a generator only adds, so a
 * negation the consumer wrote for a project not generated yet survives the
 * generators that run before it. Every other entry is the consumer's and kept
 * as it is. Returns whether the root manifest changed.
 */
export function keepLayerManifestsOutOfTheRootWorkspace(
  tree: Tree,
  { removeStale }: { readonly removeStale: boolean },
): boolean {
  const projects = {
    agentic: readAgenticProjects(tree),
    workflow: readWorkflowProjects(tree),
  };
  const manifest = readJson<{
    workspaces?: string[] | { packages?: string[] };
  }>(tree, ROOT_MANIFEST);
  const globs = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages;
  if (globs === undefined) {
    throw new Error(
      `${ROOT_MANIFEST} declares no workspaces: AgentForge's projects are Bun workspace members`,
    );
  }
  const isMember = picomatch(globs.filter((glob) => !glob.startsWith('!')));
  const isExcluded = picomatch(
    globs.filter((glob) => glob.startsWith('!')).map((glob) => glob.slice(1)),
  );
  const kept = globs.filter((entry) => {
    const root = excludedRoot(entry);
    return (
      !removeStale || root === undefined || tree.exists(`${root}/project.json`)
    );
  });
  const added = [
    ...projects.agentic.map((project) => ({
      kind: 'agentic' as const,
      project,
    })),
    ...projects.workflow.map((project) => ({
      kind: 'workflow' as const,
      project,
    })),
  ]
    .filter((entry) => {
      const exclusion = exclusionOf(entry.kind, entry.project.root);
      return (
        !kept.includes(exclusion) &&
        layerManifestDirectories(entry).some(
          (directory) => isMember(directory) && !isExcluded(directory),
        )
      );
    })
    .map((entry) => exclusionOf(entry.kind, entry.project.root));
  const next = [...kept, ...added];
  if (
    next.length === globs.length &&
    next.every((entry, index) => entry === globs[index])
  ) {
    return false;
  }
  writeJson(tree, ROOT_MANIFEST, {
    ...manifest,
    workspaces: Array.isArray(manifest.workspaces)
      ? next
      : { ...manifest.workspaces, packages: next },
  });
  return true;
}
