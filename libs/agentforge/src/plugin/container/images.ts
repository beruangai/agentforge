import {
  FRAMEWORK_NAMES,
  type FrameworkName,
} from '#core/contract/framework.ts';
import type { AgenticProject } from '../project-record.ts';

/**
 * The images an agentic project builds, each `FROM` the one before: the
 * AgentForge base image, its framework's AgentForge image, the project's
 * agentic image (its base layer), and one agent image per agent. A layer's
 * image names its parent through the `BASE_IMAGE` build argument.
 */
export const AGENTFORGE_IMAGE = 'agentforge/a2a';

/** The AgentForge base image, tagged with the version it was built from. */
export function agentforgeImage(version: string): string {
  return `${AGENTFORGE_IMAGE}:${version}`;
}

/** A framework's AgentForge image, `agentforge/a2a-<framework>`, tagged with the version it was built from. */
export function frameworkImage(
  framework: FrameworkName,
  version: string,
): string {
  return `${AGENTFORGE_IMAGE}-${framework}:${version}`;
}

/** A framework's AgentForge layer: `agentforge-<framework>`. */
export function frameworkLayer(framework: FrameworkName): FrameworkLayer {
  return `agentforge-${framework}`;
}

/** The framework an AgentForge layer names, or undefined for any other layer. */
export function frameworkOfLayer(layer: string): FrameworkName | undefined {
  return FRAMEWORK_NAMES.find(
    (framework) => layer === frameworkLayer(framework),
  );
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

type FrameworkLayer = `agentforge-${FrameworkName}`;

/** A layer of an agentic project's image chain, as its executors name it. */
export type Layer = 'agentforge' | FrameworkLayer | 'base' | `agents/${string}`;

/** Where the `image` executor writes a layer's image id, relative to the workspace root. */
export function imageIdFile(projectRoot: string, layer: Layer): string {
  return `dist/${projectRoot}/image/${layer}.id`;
}

/**
 * The agent a layer names, or undefined for `agentforge`, a provided
 * framework's `agentforge-<framework>` and `base`; throws for anything else.
 */
export function agentOfLayer(
  project: Pick<AgenticProject, 'name' | 'agents'>,
  layer: string,
): string | undefined {
  if (
    layer === 'agentforge' ||
    frameworkOfLayer(layer) !== undefined ||
    layer === 'base'
  ) {
    return undefined;
  }
  const agentName = /^agents\/(.+)$/.exec(layer)?.[1];
  if (agentName === undefined) {
    throw new Error(
      `layer "${layer}" is not agentforge, ${FRAMEWORK_NAMES.map((framework) => frameworkLayer(framework)).join(', ')}, base or agents/<agent>`,
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
