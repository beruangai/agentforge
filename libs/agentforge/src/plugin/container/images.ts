import type { AgenticProject } from '../project-record.ts';

/**
 * The images an agentic project builds, each `FROM` the one before: the
 * AgentForge image, the project's agentic image (its base layer), and one
 * agent image per agent. A layer's image names its parent through the
 * `BASE_IMAGE` build argument.
 */
export const AGENTFORGE_IMAGE = 'agentforge/a2a-claude';

/** The AgentForge image, tagged with the version it was built from. */
export function agentforgeImage(version: string): string {
  return `${AGENTFORGE_IMAGE}:${version}`;
}

/** The project's agentic image: `<scope>/<project>:local`. */
export function agenticImage(
  project: Pick<AgenticProject, 'scope' | 'projectName'>,
): string {
  return `${project.scope}/${project.projectName}:local`;
}

/** An agent's image: `<scope>/<project>-<agent>:local`. */
export function agentImage(
  project: Pick<AgenticProject, 'scope' | 'projectName'>,
  agentName: string,
): string {
  return `${project.scope}/${project.projectName}-${agentName}:local`;
}

/** A layer of an agentic project's image chain, as its executors name it. */
export type Layer = 'agentforge' | 'base' | `agents/${string}`;

/** Where the `image` executor writes a layer's image id, relative to the workspace root. */
export function imageIdFile(projectRoot: string, layer: Layer): string {
  return `dist/${projectRoot}/image/${layer}.id`;
}

/** The agent a layer names, or undefined for `agentforge` and `base`; throws for anything else. */
export function agentOfLayer(
  project: Pick<AgenticProject, 'name' | 'agents'>,
  layer: string,
): string | undefined {
  if (layer === 'agentforge' || layer === 'base') return undefined;
  const agentName = /^agents\/(.+)$/.exec(layer)?.[1];
  if (agentName === undefined) {
    throw new Error(
      `layer "${layer}" is not agentforge, base or agents/<agent>`,
    );
  }
  if (!project.agents.some((agent) => agent.name === agentName)) {
    throw new Error(
      `layer "${layer}" names no agent of ${project.name}: it records ${
        project.agents.map((agent) => agent.name).join(', ') || 'none'
      }`,
    );
  }
  return agentName;
}
