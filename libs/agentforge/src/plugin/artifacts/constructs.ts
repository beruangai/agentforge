import { agenticImage, imageIdFile } from '../container/images.ts';
import { pascalCase } from '../names.ts';
import type { AgentComponent, AgenticProject } from '../project-record.ts';
import { agentDirectory, contractName, type RenderContext } from './layers.ts';
import {
  type MaintainedFile,
  maintainedHeader,
  maintainedJson,
  maintainedStarExport,
  withEntries,
} from './maintained.ts';

/** `@aws/nx-plugin`'s shared constructs project, where every construct is generated. */
export const SHARED_CONSTRUCTS_DIRECTORY = 'packages/common/constructs';
const APP = `${SHARED_CONSTRUCTS_DIRECTORY}/src/app`;

/** A project's constructs: the project's own, and under `agents/` each of its agents'. */
function projectConstructsDirectory(project: AgenticProject): string {
  return `${APP}/agentic-projects/${project.projectName}`;
}

/** `agents/writer/writer`: an agent's construct module, from its project's directory. */
function agentModule(agent: AgentComponent): string {
  return `agents/${agent.name}/${agent.name}`;
}

/** An object type of `members`, or an empty record for none. */
function objectType(members: readonly string[], indent: string): string {
  return members.length === 0
    ? 'Record<string, never>'
    : `{\n${members.map((member) => `${indent}  ${member}`).join('\n')}\n${indent}}`;
}

/** A relative module specifier, `.js`-suffixed in an ES-module workspace. */
function specifier(context: RenderContext, module: string): string {
  return context.esm ? `${module}.js` : module;
}

/**
 * An agent's construct: the agent as its own AgentCore runtime, built from
 * its layer on the agentic image and redeployed when the image below it
 * changes, registered in the runtime configuration under its key. Its props
 * require exactly the secrets AgentForge, the base layer and the agent
 * declare, typed from the layers' own `secrets.ts`.
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
export type ${name}Secrets = AgentSecrets<
  (typeof PROJECT_SECRETS)[number] | (typeof AGENT_SECRETS)[number]
>;

export type ${name}Props = Omit<
  AgentRuntimeProps,
  'agentRuntimeArtifact' | 'secrets'
> & {
  readonly secrets: ${name}Secrets;
};

/**
 * ${project.projectName}'s ${agent.name} agent as its own AgentCore runtime, registered in the
 * runtime configuration as ${name}.
 */
export class ${name} extends AgentRuntime {
  constructor(scope: Construct, id: string, props: ${name}Props) {
    super(scope, id, {
      ...props,
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

/**
 * The project construct: every agent's construct, each agent's runtime
 * options, and the grant a caller of the project needs — invocation of
 * exactly its agents, and read of the stage's runtime configuration.
 */
export function projectConstruct(context: RenderContext): MaintainedFile {
  const { project } = context;
  const name = pascalCase(project.projectName);
  const agents = [...project.agents].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const imports = agents.map(
    (agent) => `import {
  ${agent.runtimeConfigKey},
  type ${agent.runtimeConfigKey}Props,
} from '${specifier(context, `./${agentModule(agent)}`)}';`,
  );
  const hasAgents = project.agents.length > 0;
  return {
    path: `${projectConstructsDirectory(project)}/${project.projectName}.ts`,
    render: () => `${maintainedHeader('//')}
import type { IGrantable } from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { RuntimeConfig } from '${specifier(context, '../../../core/runtime-config')}';
${imports.join('\n')}

export interface ${name}Props {
  /** Each agent's runtime options, with the secrets it requires. */
  readonly agents${hasAgents ? '' : '?'}: ${objectType(
    project.agents.map(
      (agent) =>
        `readonly ${contractName(agent)}: ${agent.runtimeConfigKey}Props;`,
    ),
    '  ',
  )};
}

/**
 * ${project.projectName}'s agents, each its own AgentCore runtime registered in the stage's
 * runtime configuration, and the grant a caller of the project needs.
 */
export class ${name} extends Construct {
  readonly agents: ${objectType(
    project.agents.map(
      (agent) => `readonly ${contractName(agent)}: ${agent.runtimeConfigKey};`,
    ),
    '  ',
  )};
  /** The runtime configuration's AppConfig application, from which the project client resolves each agent. */
  readonly runtimeConfigApplicationId: string;

  constructor(scope: Construct, id: string, ${hasAgents ? `props: ${name}Props` : `_props: ${name}Props = {}`}) {
    super(scope, id);
    this.agents = {
${project.agents
  .map(
    (agent) =>
      `      ${contractName(agent)}: new ${agent.runtimeConfigKey}(this, '${pascalCase(agent.name)}', props.agents.${contractName(agent)}),`,
  )
  .join('\n')}
    };
    this.runtimeConfigApplicationId =
      RuntimeConfig.ensure(this).appConfigApplicationId;
  }

  /** Invocation of exactly this project's agents, and read of the stage's runtime configuration. */
  grantInvoke(grantee: IGrantable): void {
${project.agents.map((agent) => `    this.agents.${contractName(agent)}.grantInvoke(grantee);`).join('\n')}
    RuntimeConfig.ensure(this).grantReadAppConfig(grantee);
  }
}
`,
  };
}

/** The star exports that make every construct importable from the shared constructs package. */
export function constructExports(context: RenderContext): MaintainedFile[] {
  const { project } = context;
  return [
    maintainedStarExport(
      `${APP}/index.ts`,
      specifier(context, './agentic-projects/index'),
    ),
    maintainedStarExport(
      `${APP}/agentic-projects/index.ts`,
      specifier(context, `./${project.projectName}/${project.projectName}`),
    ),
    ...project.agents.map((agent) =>
      maintainedStarExport(
        `${APP}/agentic-projects/index.ts`,
        specifier(context, `./${project.projectName}/${agentModule(agent)}`),
      ),
    ),
  ];
}

/**
 * The shared constructs project's maintained keys: its dependencies on
 * AgentForge and on the project, whose layers' secrets its agents' constructs
 * are typed from, and its `assemble` building the project's images, so an
 * infra project's synth builds what an asset builds `FROM`.
 */
export function sharedConstructsKeys(context: RenderContext): MaintainedFile[] {
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
