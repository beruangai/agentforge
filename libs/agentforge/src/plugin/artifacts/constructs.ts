import { agenticImage, imageIdFile } from '../container/images.ts';
import { pascalCase } from '../names.ts';
import type {
  AgentComponent,
  AgenticProject,
  WorkflowProject,
} from '../project-record.ts';
import { agentDirectory, agentKey, type RenderContext } from './layers.ts';
import {
  type MaintainedFile,
  maintainedHeader,
  maintainedJson,
  maintainedStarExport,
  withEntries,
} from './maintained.ts';
import type { WorkflowRenderContext } from './workflow-project.ts';

/** `@aws/nx-plugin`'s shared constructs project, where every construct is generated. */
export const SHARED_CONSTRUCTS_DIRECTORY = 'packages/common/constructs';
const APP = `${SHARED_CONSTRUCTS_DIRECTORY}/src/app`;

/** A project's constructs: the project's own, and under `agents/` each of its agents'. */
function projectConstructsDirectory(project: AgenticProject): string {
  return `${APP}/agentic-projects/${project.projectName}`;
}

/** `agents/writer/agent`: an agent's construct module, from its project's directory. */
function agentModule(agent: AgentComponent): string {
  return `agents/${agent.name}/agent`;
}

/** The project construct's module, from its project's directory. */
const PROJECT_MODULE = 'project';

/** An object type of `members`, or an empty record for none. */
function objectType(members: readonly string[], indent: string): string {
  return members.length === 0
    ? 'Record<string, never>'
    : `{\n${members.map((member) => `${indent}  ${member}`).join('\n')}\n${indent}}`;
}

/** A relative module specifier, `.js`-suffixed in an ES-module workspace. */
function specifier(
  context: Pick<RenderContext, 'esm'>,
  module: string,
): string {
  return context.esm ? `${module}.js` : module;
}

/**
 * An agent's construct: the agent as its own AgentCore runtime, named as its
 * image names it, built from its layer on the agentic image and redeployed
 * when the image below it changes, registered in the runtime configuration
 * under its key. Its props
 * require exactly the secrets AgentForge, the base layer and the agent
 * declare, typed from the layers' own `secrets.ts`. It exports generic names
 * — `Agent`, `AgentProps`, `Secrets` — which the project's index aliases.
 */
export function agentConstruct(
  context: RenderContext,
  agent: AgentComponent,
): MaintainedFile {
  const { project } = context;
  const name = agent.runtimeConfigKey;
  const fileUrl = context.esm ? 'fileURLToPath(import.meta.url)' : '__filename';
  const core = '../../../../../core';
  return {
    path: `${projectConstructsDirectory(project)}/${agentModule(agent)}.ts`,
    render: () => `${maintainedHeader('//')}
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
${context.esm ? "import { fileURLToPath } from 'node:url';\n" : ''}import {
  AgentRuntime,
  type AgentRuntimeProps,
  type AgentSecrets,
} from '@beruangai/agentforge/infra';
import type { REQUIRED_SECRETS as PROJECT_SECRETS } from '${project.packageName}/secrets';
import type { REQUIRED_SECRETS as AGENT_SECRETS } from '${project.packageName}/${agent.name}/secrets';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import type { Construct } from 'constructs';
import { RuntimeConfig } from '${specifier(context, `${core}/runtime-config`)}';
import { findWorkspaceRoot } from '${specifier(context, `${core}/workspace`)}';

const WORKSPACE_ROOT = findWorkspaceRoot(${fileUrl});
/** The agent's layer: its image's build context. */
const LAYER_DIRECTORY = join(WORKSPACE_ROOT, '${agentDirectory(project, agent)}');
/** The id of the agentic image the agent's image builds on. */
const PARENT_IMAGE_ID_FILE = join(WORKSPACE_ROOT, '${imageIdFile(project.root, 'base')}');

function parentImageId(): string {
  try {
    return readFileSync(PARENT_IMAGE_ID_FILE, 'utf8').trim();
  } catch (error) {
    throw new Error(
      \`\${PARENT_IMAGE_ID_FILE} is missing: build the agentic image first, with nx run ${project.name}:image\`,
      { cause: error },
    );
  }
}

/**
 * The ${agent.name} agent's secrets, by the environment variable each becomes:
 * AgentForge's own, the base layer's and the agent's \`REQUIRED_SECRETS\`.
 */
export type Secrets = AgentSecrets<
  (typeof PROJECT_SECRETS)[number] | (typeof AGENT_SECRETS)[number]
>;

export type AgentProps = Omit<
  AgentRuntimeProps,
  'agentRuntimeArtifact' | 'secrets' | 'agentName'
> & {
  readonly secrets: Secrets;
};

/**
 * ${project.projectName}'s ${agent.name} agent as its own AgentCore runtime, registered in the
 * runtime configuration as ${name}.
 */
export class Agent extends AgentRuntime {
  constructor(scope: Construct, id: string, props: AgentProps) {
    super(scope, id, {
      ...props,
      agentName: '${agent.name}',
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(LAYER_DIRECTORY, {
        platform: Platform.LINUX_ARM64,
        buildArgs: { BASE_IMAGE: '${agenticImage(project)}' },
        // The asset hash covers the agent's layer only; a change below it
        // changes the agentic image's id, and redeploys the agent.
        extraHash: parentImageId(),
      }),
    });
    const runtimeConfig = RuntimeConfig.ensure(this);
    runtimeConfig.set('agentcore', 'agentRuntimes', {
      ...runtimeConfig.get('agentcore').agentRuntimes,
      ${name}: { arn: this.agentRuntimeArn },
    });
  }
}
`,
  };
}

/** How the project construct imports an agent's construct: `writer` → `WriterAgent`. */
function agentAlias(agent: AgentComponent): string {
  return `${pascalCase(agent.name)}Agent`;
}

/**
 * The project construct: what its agents share, once — the table, bucket,
 * dashboard and readiness probe — with the options that are the project's,
 * every agent's construct, each agent's runtime options, and the grant a
 * caller of the project needs — invocation of
 * exactly its agents, and read of the stage's runtime configuration. It
 * exports `AgenticProject` and `AgenticProjectProps`, which the project's
 * index aliases.
 */
export function projectConstruct(context: RenderContext): MaintainedFile {
  const { project } = context;
  const agents = [...project.agents].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const imports = agents.map(
    (agent) => `import {
  Agent as ${agentAlias(agent)},
  type AgentProps as ${agentAlias(agent)}Props,
} from '${specifier(context, `./${agentModule(agent)}`)}';`,
  );
  const hasAgents = project.agents.length > 0;
  return {
    path: `${projectConstructsDirectory(project)}/${PROJECT_MODULE}.ts`,
    render: () => `${maintainedHeader('//')}
import {
  AgenticProjectResources,
  type AgenticProjectResourcesProps,
} from '@beruangai/agentforge/infra';
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RuntimeConfig } from '${specifier(context, '../../../core/runtime-config')}';
${imports.join('\n')}

export interface AgenticProjectProps
  extends Omit<AgenticProjectResourcesProps, 'projectName'> {
  /** Each agent's runtime options, with the secrets it requires; the project's resources are passed to each. */
  readonly agents${hasAgents ? '' : '?'}: ${objectType(
    project.agents.map(
      (agent) =>
        `readonly ${agentKey(agent)}: Omit<${agentAlias(agent)}Props, 'project'>;`,
    ),
    '  ',
  )};
}

/**
 * ${project.projectName}'s agents, each its own AgentCore runtime registered in the stage's
 * runtime configuration, sharing one task table, session bucket, dashboard and
 * readiness probe, and the grant a caller of the project needs.
 */
export class AgenticProject extends Construct {
  /** What the project's agents share. */
  readonly resources: AgenticProjectResources;
  readonly agents: ${objectType(
    project.agents.map(
      (agent) => `readonly ${agentKey(agent)}: ${agentAlias(agent)};`,
    ),
    '  ',
  )};
  /** The runtime configuration's AppConfig application, from which the project client resolves each agent. */
  readonly runtimeConfigApplicationId: string;

  constructor(scope: Construct, id: string, ${hasAgents ? 'props: AgenticProjectProps' : 'props: AgenticProjectProps = {}'}) {
    super(scope, id);
    const { agents${hasAgents ? '' : ': _agents'}, ...shared } = props;
    this.resources = new AgenticProjectResources(this, 'Resources', {
      projectName: '${project.projectName}',
      ...shared,
    });
    this.agents = {
${project.agents
  .map(
    (agent) =>
      `      ${agentKey(agent)}: new ${agentAlias(agent)}(this, '${pascalCase(agent.name)}', {\n        ...agents.${agentKey(agent)},\n        project: this.resources,\n      }),`,
  )
  .join('\n')}
    };
    this.runtimeConfigApplicationId =
      RuntimeConfig.ensure(this).appConfigApplicationId;
  }

  /** Invocation of exactly this project's agents, and read of the stage's runtime configuration. */
  grantInvoke(grantee: IGrantable): void {
${project.agents.map((agent) => `    this.agents.${agentKey(agent)}.grantInvoke(grantee);`).join('\n')}
    RuntimeConfig.ensure(this).grantReadAppConfig(grantee);
  }
}
`,
  };
}

/**
 * The project's index: its constructs under the names the shared constructs
 * package exports them by — the project's (`GoldenKata`) and each agent's
 * runtime-configuration key (`GoldenKataWriter`) — so two projects' generic
 * modules never collide in the package's star exports.
 */
export function projectConstructsIndex(context: RenderContext): MaintainedFile {
  const { project } = context;
  const name = pascalCase(project.projectName);
  const agents = [...project.agents].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return {
    path: `${projectConstructsDirectory(project)}/index.ts`,
    render: () =>
      [
        maintainedHeader('//'),
        'export {',
        `  AgenticProject as ${name},`,
        `  type AgenticProjectProps as ${name}Props,`,
        `} from '${specifier(context, `./${PROJECT_MODULE}`)}';`,
        ...agents.flatMap((agent) => [
          'export {',
          `  Agent as ${agent.runtimeConfigKey},`,
          `  type AgentProps as ${agent.runtimeConfigKey}Props,`,
          `  type Secrets as ${agent.runtimeConfigKey}Secrets,`,
          `} from '${specifier(context, `./${agentModule(agent)}`)}';`,
        ]),
        '',
      ].join('\n'),
  };
}

/** The star exports that make every project's constructs importable from the shared constructs package. */
export function constructExports(context: RenderContext): MaintainedFile[] {
  const { project } = context;
  return [
    maintainedStarExport(
      `${APP}/index.ts`,
      specifier(context, './agentic-projects/index'),
    ),
    maintainedStarExport(
      `${APP}/agentic-projects/index.ts`,
      specifier(context, `./${project.projectName}/index`),
    ),
  ];
}

/**
 * The shared constructs project's maintained keys: its dependencies on
 * AgentForge and on the project, whose secrets its constructs are typed
 * from, and its `assemble` building what the project's assets are built
 * from — an agentic project's images, a workflow project's worker bundle —
 * so an infra project's synth finds them.
 */
export function sharedConstructsKeys(context: {
  readonly agentforgeSpecifier: string;
  readonly project: Pick<
    AgenticProject | WorkflowProject,
    'name' | 'packageName'
  >;
}): MaintainedFile[] {
  return [
    maintainedJson(`${SHARED_CONSTRUCTS_DIRECTORY}/package.json`, (current) =>
      withEntries(current, 'dependencies', {
        '@beruangai/agentforge': context.agentforgeSpecifier,
        [context.project.packageName]: 'workspace:*',
      }),
    ),
    maintainedJson(`${SHARED_CONSTRUCTS_DIRECTORY}/project.json`, (current) => {
      const targets = (current.targets ?? {}) as Record<
        string,
        { dependsOn?: unknown[] }
      >;
      const assemble = targets.assemble ?? {};
      const edge = `${context.project.name}:assemble`;
      const dependsOn = assemble.dependsOn ?? [];
      return {
        ...current,
        targets: {
          ...targets,
          assemble: {
            ...assemble,
            dependsOn: dependsOn.includes(edge)
              ? dependsOn
              : [...dependsOn, edge],
          },
        },
      };
    }),
  ];
}

/** A workflow project's constructs directory. */
function workflowProjectConstructsDirectory(project: WorkflowProject): string {
  return `${APP}/workflow-projects/${project.projectName}`;
}

/**
 * A workflow project's construct: its worker on ECS, from the project's
 * `bundle` output, requiring each connected agentic project's construct and
 * granted invocation of exactly their agents and read of the runtime
 * configuration that resolves them. Its secrets are typed from the
 * project's `secrets.ts`, beside the Temporal API key. It exports
 * `WorkflowProject`, `WorkflowProjectProps` and `Secrets`, which the
 * project's index aliases.
 */
export function workflowProjectConstruct(
  context: WorkflowRenderContext,
): MaintainedFile {
  const { project } = context;
  const connected = [...context.connected].sort((a, b) =>
    a.connection.key.localeCompare(b.connection.key),
  );
  const alias = (projectName: string) => pascalCase(projectName);
  const imports = connected.map(
    ({ agenticProject }) =>
      `import { AgenticProject as ${alias(agenticProject.projectName)} } from '${specifier(context, `../../agentic-projects/${agenticProject.projectName}/${PROJECT_MODULE}`)}';`,
  );
  const hasConnections = connected.length > 0;
  const fileUrl = context.esm ? 'fileURLToPath(import.meta.url)' : '__filename';
  return {
    path: `${workflowProjectConstructsDirectory(project)}/${PROJECT_MODULE}.ts`,
    render: () => `${maintainedHeader('//')}
import { existsSync } from 'node:fs';
import { join } from 'node:path';
${context.esm ? "import { fileURLToPath } from 'node:url';\n" : ''}import {
  TemporalWorker,
  type TemporalWorkerProps,
  type WorkerSecrets,
} from '@beruangai/agentforge/infra';
import type { REQUIRED_SECRETS as PROJECT_SECRETS } from '${project.packageName}/secrets';
import type { Construct } from 'constructs';
import { RuntimeConfig } from '${specifier(context, '../../../core/runtime-config')}';
import { findWorkspaceRoot } from '${specifier(context, '../../../core/workspace')}';
${imports.join('\n')}

const WORKSPACE_ROOT = findWorkspaceRoot(${fileUrl});
/** The worker's image build context: the project's \`bundle\` output. */
const BUNDLE_DIRECTORY = join(WORKSPACE_ROOT, 'dist/${project.root}/bundle');

function bundleDirectory(): string {
  if (!existsSync(join(BUNDLE_DIRECTORY, 'worker.mjs'))) {
    throw new Error(
      \`\${BUNDLE_DIRECTORY}/worker.mjs is missing: bundle the worker first, with nx run ${project.name}:bundle\`,
    );
  }
  return BUNDLE_DIRECTORY;
}

/**
 * The worker's secrets, by the environment variable each becomes: the
 * Temporal Cloud API key, and the project's \`REQUIRED_SECRETS\`.
 */
export type Secrets = WorkerSecrets<(typeof PROJECT_SECRETS)[number]>;

export type WorkflowProjectProps = Omit<
  TemporalWorkerProps,
  'directory' | 'secrets' | 'agents'
> & {
  readonly secrets: Secrets;
  /** Each connected agentic project's construct: the worker may invoke its agents. */
  readonly agenticProjects${hasConnections ? '' : '?'}: ${objectType(
    connected.map(
      ({ connection, agenticProject }) =>
        `readonly ${connection.key}: ${alias(agenticProject.projectName)};`,
    ),
    '  ',
  )};
};

/**
 * ${project.projectName}'s worker on ECS, polling its task queue on Temporal Cloud,
 * granted invocation of exactly its connected projects' agents.
 */
export class WorkflowProject extends TemporalWorker {
  constructor(scope: Construct, id: string, props: WorkflowProjectProps) {
    const { agenticProjects${hasConnections ? '' : ': _agenticProjects'}, ...worker } = props;
    super(scope, id, {
      ...worker,
      directory: bundleDirectory(),
      agents: \`runtime-config:\${RuntimeConfig.ensure(scope).appConfigApplicationId}\`,
    });
${connected.map(({ connection }) => `    agenticProjects.${connection.key}.grantInvoke(this);`).join('\n')}
  }
}
`,
  };
}

/** A workflow project's index: its construct under the project's names. */
export function workflowProjectConstructsIndex(
  context: WorkflowRenderContext,
): MaintainedFile {
  const { project } = context;
  const name = pascalCase(project.projectName);
  return {
    path: `${workflowProjectConstructsDirectory(project)}/index.ts`,
    render: () =>
      [
        maintainedHeader('//'),
        'export {',
        `  WorkflowProject as ${name},`,
        `  type WorkflowProjectProps as ${name}Props,`,
        `  type Secrets as ${name}Secrets,`,
        `} from '${specifier(context, `./${PROJECT_MODULE}`)}';`,
        '',
      ].join('\n'),
  };
}

/** The star exports that make a workflow project's construct importable from the shared constructs package. */
export function workflowConstructExports(
  context: WorkflowRenderContext,
): MaintainedFile[] {
  const { project } = context;
  return [
    maintainedStarExport(
      `${APP}/index.ts`,
      specifier(context, './workflow-projects/index'),
    ),
    maintainedStarExport(
      `${APP}/workflow-projects/index.ts`,
      specifier(context, `./${project.projectName}/index`),
    ),
  ];
}
