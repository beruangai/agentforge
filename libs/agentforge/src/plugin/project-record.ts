import { relative } from 'node:path';
import {
  getProjects,
  type ProjectConfiguration,
  readJson,
  type Tree,
  updateProjectConfiguration,
} from '@nx/devkit';
import { z } from 'zod';
import { camelCase, KebabNameField, pascalCase, scopeOf } from './names.ts';

/**
 * An agentic project's record: what `project.json`'s `metadata` holds, in
 * `@aws/nx-plugin`'s form — the generator that made the project, and one
 * component per agent — plus what the consumer detached. Every artifact that
 * spans the project's agents is derived from it. Generators only append to
 * it; the rest is the consumer's to edit. A workflow project's record, read
 * beside it, is at the end of this module.
 */
export const AGENTIC_PROJECT_GENERATOR =
  '@beruangai/agentforge:agentic-project';
export const AGENT_GENERATOR = '@beruangai/agentforge:agent';

export const AgentComponentSchema = z.object({
  generator: z.literal(AGENT_GENERATOR),
  name: KebabNameField,
  path: z.string(),
  /** The agent's key in the runtime configuration's `agentcore.agentRuntimes`. */
  runtimeConfigKey: z.string().regex(/^[A-Z][A-Za-z0-9]*$/),
  /** The local container the agent is served as, and found by. */
  containerName: z.string().regex(/^[a-z0-9][a-z0-9_.-]*$/),
});
export type AgentComponent = z.infer<typeof AgentComponentSchema>;

/** A component any generator recorded; AgentForge reads only its own. */
const ComponentSchema = z.looseObject({
  generator: z.string(),
  name: z.string().optional(),
  path: z.string(),
});

/** Maintained artifacts the consumer owns from now on: workspace-relative files, and target names. */
export const DetachedSchema = z.object({
  files: z.array(z.string()),
  targets: z.array(z.string()),
});
export type Detached = z.infer<typeof DetachedSchema>;

export const AgenticProjectMetadataSchema = z.looseObject({
  generator: z.literal(AGENTIC_PROJECT_GENERATOR),
  components: z.array(ComponentSchema),
  agentforge: z.object({ detached: DetachedSchema }),
});

export interface AgenticProject {
  /** The Nx project's name. */
  readonly name: string;
  /** Its workspace-relative root. */
  readonly root: string;
  /** The host package's name, `@<scope>/<project>`, by which its layers are imported. */
  readonly packageName: string;
  /** The project's own name, the last segment of its package name: `golden-kata`. */
  readonly projectName: string;
  readonly scope: string;
  readonly agents: readonly AgentComponent[];
  readonly detached: Detached;
}

export function isAgenticProject(configuration: ProjectConfiguration): boolean {
  return configuration.metadata?.generator === AGENTIC_PROJECT_GENERATOR;
}

/** The record of a project known to be agentic, from its configuration and its package name. */
export function agenticProjectOf(
  configuration: ProjectConfiguration,
  packageName: string,
): AgenticProject {
  const name = configuration.name ?? configuration.root;
  const parsed = AgenticProjectMetadataSchema.safeParse(configuration.metadata);
  if (!parsed.success) {
    throw new Error(
      `${name}'s project.json metadata is not an agentic project's record: ${z.prettifyError(parsed.error)}`,
    );
  }
  const agents = parsed.data.components
    .filter((component) => component.generator === AGENT_GENERATOR)
    .map((component) => {
      const agent = AgentComponentSchema.safeParse(component);
      if (!agent.success) {
        throw new Error(
          `${name}'s component ${JSON.stringify(component.name ?? component.path)} is not an agent's record: ${z.prettifyError(agent.error)}`,
        );
      }
      return agent.data;
    });
  const names = agents.map((agent) => agent.name);
  const repeated = names.filter((agentName, index) =>
    names.includes(agentName, index + 1),
  );
  if (repeated.length > 0) {
    throw new Error(
      `${name} records the agent ${repeated.join(', ')} more than once`,
    );
  }
  const projectName = packageName.split('/').pop() ?? packageName;
  KebabNameField.parse(projectName);
  return {
    name,
    root: configuration.root,
    packageName,
    projectName,
    scope: scopeOf(packageName),
    agents,
    detached: parsed.data.agentforge.detached,
  };
}

/** A project's configuration by its name, or by its name without the workspace scope. */
export function findProject(
  tree: Tree,
  projectName: string,
): ProjectConfiguration & { name: string } {
  const projects = getProjects(tree);
  const found =
    projects.get(projectName) ??
    [...projects.values()].find(
      (project) => project.name?.split('/').pop() === projectName,
    );
  if (found?.name === undefined) {
    throw new Error(`no project named ${projectName}`);
  }
  return { ...found, name: found.name };
}

function packageNameOf(tree: Tree, root: string): string {
  const path = `${root}/package.json`;
  if (!tree.exists(path)) throw new Error(`${path} does not exist`);
  const { name } = readJson<{ name?: unknown }>(tree, path);
  if (typeof name !== 'string') throw new Error(`${path} names no package`);
  return name;
}

/** An agentic project in the tree, throwing when the project is missing or not agentic. */
export function readAgenticProject(
  tree: Tree,
  projectName: string,
): AgenticProject {
  const configuration = findProject(tree, projectName);
  if (!isAgenticProject(configuration)) {
    throw new Error(
      `${configuration.name} is not an agentic project: its metadata.generator is not ${AGENTIC_PROJECT_GENERATOR}`,
    );
  }
  return agenticProjectOf(
    configuration,
    packageNameOf(tree, configuration.root),
  );
}

/** Every agentic project in the tree. */
export function readAgenticProjects(tree: Tree): AgenticProject[] {
  return [...getProjects(tree).values()]
    .filter(isAgenticProject)
    .map((configuration) =>
      agenticProjectOf(configuration, packageNameOf(tree, configuration.root)),
    );
}

/** The record an agent is given when it is generated: its key and container name, assigned once. */
export function agentComponent(
  project: Pick<AgenticProject, 'scope' | 'projectName'>,
  agentName: string,
): AgentComponent {
  return {
    generator: AGENT_GENERATOR,
    name: agentName,
    path: `agents/${agentName}`,
    runtimeConfigKey: `${pascalCase(project.projectName)}${pascalCase(agentName)}`,
    containerName: `${project.scope}-${project.projectName}-${agentName}`,
  };
}

/**
 * Appends an agent's record, unless one of that name exists — the record is
 * assigned once, and the consumer's to edit after. A component another
 * generator recorded under the same name is a collision.
 */
export function appendAgentComponent(
  tree: Tree,
  projectName: string,
  component: AgentComponent,
): void {
  const configuration = findProject(tree, projectName);
  const metadata = AgenticProjectMetadataSchema.parse(configuration.metadata);
  const existing = metadata.components.find(
    (recorded) => recorded.name === component.name,
  );
  if (existing?.generator === AGENT_GENERATOR) return;
  if (existing !== undefined) {
    throw new Error(
      `${configuration.name} already has a component named ${component.name}, recorded by ${existing.generator}`,
    );
  }
  const { targets, ...rest } = configuration;
  updateProjectConfiguration(tree, configuration.name, {
    ...rest,
    metadata: {
      ...configuration.metadata,
      components: [...metadata.components, component],
    },
    ...(targets === undefined ? {} : { targets }),
  });
}

/**
 * A workflow project's record: the generator that made it, one component per
 * connection — an agentic project its workflows call — and what the
 * consumer detached. The connection lives on the caller, which knows what it
 * calls; an agentic project serves callers it need not know.
 */
export const WORKFLOW_PROJECT_GENERATOR =
  '@beruangai/agentforge:workflow-project';
export const CONNECTION_GENERATOR = '@beruangai/agentforge:connection';

export const ConnectionComponentSchema = z.object({
  generator: z.literal(CONNECTION_GENERATOR),
  /** The agentic project's own name, `golden-kata`. */
  name: KebabNameField,
  /** Where the agentic project is, from the workflow project; for display only. */
  path: z.string(),
  /** How the rendered imports name it, and how it is found in the graph. */
  packageName: z.string(),
  /** Its key in activity names and in `agents.<key>`: `goldenKata`. */
  key: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
});
export type ConnectionComponent = z.infer<typeof ConnectionComponentSchema>;

export const WorkflowProjectMetadataSchema = z.looseObject({
  generator: z.literal(WORKFLOW_PROJECT_GENERATOR),
  components: z.array(ComponentSchema),
  agentforge: z.object({ detached: DetachedSchema }),
});

export interface WorkflowProject {
  /** The Nx project's name. */
  readonly name: string;
  /** Its workspace-relative root. */
  readonly root: string;
  /** The host package's name, `@<scope>/<project>`. */
  readonly packageName: string;
  /** The last segment of its package name: `golden-kata-workflows`. */
  readonly projectName: string;
  readonly scope: string;
  readonly connections: readonly ConnectionComponent[];
  readonly detached: Detached;
}

export function isWorkflowProject(
  configuration: ProjectConfiguration,
): boolean {
  return configuration.metadata?.generator === WORKFLOW_PROJECT_GENERATOR;
}

/** The record of a project known to be a workflow project. */
export function workflowProjectOf(
  configuration: ProjectConfiguration,
  packageName: string,
): WorkflowProject {
  const name = configuration.name ?? configuration.root;
  const parsed = WorkflowProjectMetadataSchema.safeParse(
    configuration.metadata,
  );
  if (!parsed.success) {
    throw new Error(
      `${name}'s project.json metadata is not a workflow project's record: ${z.prettifyError(parsed.error)}`,
    );
  }
  const connections = parsed.data.components
    .filter((component) => component.generator === CONNECTION_GENERATOR)
    .map((component) => {
      const connection = ConnectionComponentSchema.safeParse(component);
      if (!connection.success) {
        throw new Error(
          `${name}'s component ${JSON.stringify(component.name ?? component.path)} is not a connection's record: ${z.prettifyError(connection.error)}`,
        );
      }
      return connection.data;
    });
  for (const field of ['packageName', 'key'] as const) {
    const values = connections.map((connection) => connection[field]);
    const repeated = values.filter((value, index) =>
      values.includes(value, index + 1),
    );
    if (repeated.length > 0) {
      throw new Error(
        `${name} records the connection ${field} ${repeated.join(', ')} more than once`,
      );
    }
  }
  const projectName = packageName.split('/').pop() ?? packageName;
  KebabNameField.parse(projectName);
  return {
    name,
    root: configuration.root,
    packageName,
    projectName,
    scope: scopeOf(packageName),
    connections,
    detached: parsed.data.agentforge.detached,
  };
}

/** A workflow project in the tree, throwing when the project is missing or not one. */
export function readWorkflowProject(
  tree: Tree,
  projectName: string,
): WorkflowProject {
  const configuration = findProject(tree, projectName);
  if (!isWorkflowProject(configuration)) {
    throw new Error(
      `${configuration.name} is not a workflow project: its metadata.generator is not ${WORKFLOW_PROJECT_GENERATOR}`,
    );
  }
  return workflowProjectOf(
    configuration,
    packageNameOf(tree, configuration.root),
  );
}

/** Every workflow project in the tree. */
export function readWorkflowProjects(tree: Tree): WorkflowProject[] {
  return [...getProjects(tree).values()]
    .filter(isWorkflowProject)
    .map((configuration) =>
      workflowProjectOf(configuration, packageNameOf(tree, configuration.root)),
    );
}

/** A connection with the agentic project it names. */
export interface Connected {
  readonly connection: ConnectionComponent;
  readonly agenticProject: AgenticProject;
}

/**
 * Each of a workflow project's connections with its agentic project, found
 * among the workspace's by package name. A connection whose project is gone
 * throws, naming the record.
 */
export function connectedProjects(
  project: WorkflowProject,
  agenticProjects: readonly AgenticProject[],
): Connected[] {
  return project.connections.map((connection) => {
    const agenticProject = agenticProjects.find(
      (candidate) => candidate.packageName === connection.packageName,
    );
    if (agenticProject === undefined) {
      throw new Error(
        `${project.name} records a connection to ${connection.packageName}, which is not an agentic project in the workspace; remove the record from its project.json metadata.components, or restore the project`,
      );
    }
    return { connection, agenticProject };
  });
}

/** The record a connection is given when it is generated. */
export function connectionComponent(
  project: Pick<WorkflowProject, 'root'>,
  agenticProject: Pick<AgenticProject, 'root' | 'packageName' | 'projectName'>,
): ConnectionComponent {
  return {
    generator: CONNECTION_GENERATOR,
    name: agenticProject.projectName,
    path: relative(project.root, agenticProject.root),
    packageName: agenticProject.packageName,
    key: camelCase(agenticProject.projectName),
  };
}

/**
 * Appends a connection's record, unless one to that package exists. Another
 * component of the same name or key is a collision.
 */
export function appendConnectionComponent(
  tree: Tree,
  projectName: string,
  component: ConnectionComponent,
): void {
  const configuration = findProject(tree, projectName);
  const metadata = WorkflowProjectMetadataSchema.parse(configuration.metadata);
  const recorded = workflowProjectOf(
    configuration,
    packageNameOf(tree, configuration.root),
  ).connections;
  if (
    recorded.some((existing) => existing.packageName === component.packageName)
  ) {
    return;
  }
  const colliding = metadata.components.find(
    (existing) =>
      existing.name === component.name ||
      (existing as { key?: unknown }).key === component.key,
  );
  if (colliding !== undefined) {
    throw new Error(
      `${configuration.name} already has a component named ${colliding.name ?? colliding.path}, recorded by ${colliding.generator}; it collides with the connection to ${component.packageName}`,
    );
  }
  const { targets, ...rest } = configuration;
  updateProjectConfiguration(tree, configuration.name, {
    ...rest,
    metadata: {
      ...configuration.metadata,
      components: [...metadata.components, component],
    },
    ...(targets === undefined ? {} : { targets }),
  });
}
