import { camelCase } from '../names.ts';
import type { AgentComponent, AgenticProject } from '../project-record.ts';
import {
  type MaintainedFile,
  maintainedHeader,
  maintainedJson,
  withEntries,
} from './maintained.ts';

/** What rendering reads beside the project's record. */
export interface RenderContext {
  readonly project: AgenticProject;
  /** How the workspace root depends on AgentForge; generated manifests repeat it. */
  readonly agentforgeSpecifier: string;
  /** AgentForge's range for each dependency of the container workspace's root. */
  readonly runtimePeers: Readonly<Record<string, string>>;
  /** Whether the workspace is ES modules, so relative imports carry `.js`. */
  readonly esm: boolean;
  /** The custom conditions the workspace's base tsconfig declares. */
  readonly baseConditions: readonly string[];
}

/** The export condition under which AgentForge's `/agent` and `/server` resolve. */
export const AGENT_CONDITION = 'agentforge-agent';

export function baseDirectory(project: AgenticProject): string {
  return `${project.root}/base`;
}

export function agentDirectory(
  project: AgenticProject,
  agent: Pick<AgentComponent, 'name'>,
): string {
  return `${project.root}/agents/${agent.name}`;
}

/**
 * The base layer's package name, `@<scope>/<project>-base`: what agents import
 * its modules by — linked by the container workspace in the image, mapped by
 * the project's tsconfig `paths` in the host.
 */
export function basePackageName(project: AgenticProject): string {
  return `${project.packageName}-base`;
}

/** The base layer's `secrets.ts`: the secrets every agent in the project requires. */
export function baseSecretsFile(project: AgenticProject): string {
  return `${baseDirectory(project)}/agentic/secrets.ts`;
}

/** An agent's `secrets.ts`: the secrets it alone requires. */
export function agentSecretsFile(
  project: AgenticProject,
  agent: Pick<AgentComponent, 'name'>,
): string {
  return `${agentDirectory(project, agent)}/agent/secrets.ts`;
}

/** The name of an agent's contract, as its module exports it: `code-reviewer` → `codeReviewer`. */
export function contractName(agent: Pick<AgentComponent, 'name'>): string {
  return camelCase(agent.name);
}

/**
 * A layer's Dockerfile starts with this parser directive, which must precede
 * every comment: `BASE_IMAGE` has no default, since the image executor and
 * the agent's construct always pass it, and a missing one fails the build.
 */
const DOCKERFILE_DIRECTIVE = '# check=skip=InvalidDefaultArgInFrom';

/** The agentic image: the base layer on the AgentForge image. */
export function baseDockerfile(project: AgenticProject): MaintainedFile {
  return {
    path: `${baseDirectory(project)}/Dockerfile`,
    render: () => `${DOCKERFILE_DIRECTIVE}
${maintainedHeader('#')}
#
# The agentic image: the project's base layer at /workspace/agentic, on the
# AgentForge image. \`agentic/$claude/\` becomes its \`.claude/\`, which every
# agent's session composes from its cwd below. The layer's lock is the whole
# workspace's up to it, so the install adds only what this layer adds.
ARG BASE_IMAGE
FROM \${BASE_IMAGE}
COPY --chown=bun --exclude=bun.lock --exclude=\\$claude agentic/ /workspace/agentic/
COPY --chown=bun agentic/\\$claude/ /workspace/agentic/.claude/
COPY --chown=bun agentic/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
`,
  };
}

/** An agent's image: its layer at /workspace/agentic/agent, its cwd, on the agentic image. */
export function agentDockerfile(
  project: AgenticProject,
  agent: AgentComponent,
): MaintainedFile {
  return {
    path: `${agentDirectory(project, agent)}/Dockerfile`,
    render: () => `${DOCKERFILE_DIRECTIVE}
${maintainedHeader('#')}
#
# The ${agent.name} agent's image: its layer at /workspace/agentic/agent — every
# run's cwd — on the project's agentic image. \`agent/$claude/\` becomes its
# \`.claude/\`, the one place a session reads \`settings.json\` and hooks from.
ARG BASE_IMAGE
FROM \${BASE_IMAGE}
COPY --chown=bun --exclude=bun.lock --exclude=\\$claude agent/ /workspace/agentic/agent/
COPY --chown=bun agent/\\$claude/ /workspace/agentic/agent/.claude/
COPY --chown=bun agent/bun.lock /workspace/bun.lock
RUN bun install --cwd /workspace --frozen-lockfile --production
ENV AGENTFORGE_AGENT_NAME=${agent.name}
CMD ["bun", "--conditions=${AGENT_CONDITION}", "server.ts"]
`,
  };
}

/**
 * The container's entry: AgentForge's server, running `task.ts` once per
 * task and requiring the secrets the base layer and the agent declare.
 */
export function serverEntry(
  project: AgenticProject,
  agent: AgentComponent,
): MaintainedFile {
  return {
    path: `${agentDirectory(project, agent)}/agent/server.ts`,
    render: () => `${maintainedHeader('//')}
//
// The container's entry: AgentForge's server, running \`task.ts\` once per task
// and requiring the secrets this project's layers declare. Everything else
// comes from the environment.
import { startServer } from '@beruangai/agentforge/server';
import { REQUIRED_SECRETS as PROJECT_SECRETS } from '${basePackageName(project)}/secrets';
import { REQUIRED_SECRETS as AGENT_SECRETS } from './secrets.ts';

await startServer({
  taskEntry: new URL('./task.ts', import.meta.url),
  requiredSecrets: [...PROJECT_SECRETS, ...AGENT_SECRETS],
});
`,
  };
}

/** The task entry: where the harness and the agent's procedures meet. */
export function taskEntry(
  project: AgenticProject,
  agent: AgentComponent,
): MaintainedFile {
  const contract = contractName(agent);
  return {
    path: `${agentDirectory(project, agent)}/agent/task.ts`,
    render: () => `${maintainedHeader('//')}
//
// The task entry: the one place the harness and this agent's procedures meet.
import { runTaskProcess } from '@beruangai/agentforge/agent';
import { ${contract} } from './contract.ts';
import { router } from './procedures.ts';

runTaskProcess({ contract: ${contract}, router });
`,
  };
}

/**
 * A container member's maintained keys: its name, its type, the layers it
 * builds on as `workspace:*`, and the container root's dependencies as peers
 * at AgentForge's ranges. Everything else in the manifest is the consumer's.
 */
function memberManifest(
  path: string,
  name: string,
  layers: readonly string[],
  context: RenderContext,
  exports?: Readonly<Record<string, string>>,
): MaintainedFile {
  return maintainedJson(path, (current) => {
    const keyed = {
      ...current,
      name,
      private: current.private ?? true,
      type: 'module',
      ...(exports === undefined ? {} : { exports }),
    };
    return withEntries(
      withEntries(
        keyed,
        'dependencies',
        Object.fromEntries(layers.map((layer) => [layer, 'workspace:*'])),
      ),
      'peerDependencies',
      context.runtimePeers,
    );
  });
}

/** The base layer's member, `/workspace/agentic`, exporting its modules by its own package name. */
export function baseManifest(context: RenderContext): MaintainedFile {
  const { project } = context;
  return memberManifest(
    `${baseDirectory(project)}/agentic/package.json`,
    basePackageName(project),
    ['@beruangai/agentforge'],
    context,
    { './*': './*.ts' },
  );
}

/** An agent's member, `/workspace/agentic/agent`, on AgentForge and the base layer. */
export function agentManifest(
  context: RenderContext,
  agent: AgentComponent,
): MaintainedFile {
  const { project } = context;
  return memberManifest(
    `${agentDirectory(project, agent)}/agent/package.json`,
    `${project.packageName}-${agent.name}`,
    ['@beruangai/agentforge', basePackageName(project)],
    context,
  );
}

/**
 * The host manifest's maintained keys: its dependency on AgentForge, and its
 * exports — the project client, each agent's contract and secrets, and the
 * base layer's modules, by the project's package name.
 */
export function hostManifest(context: RenderContext): MaintainedFile {
  const { project } = context;
  return maintainedJson(`${project.root}/package.json`, (current) =>
    withEntries(
      {
        ...current,
        exports: {
          './client': './client.ts',
          ...Object.fromEntries(
            project.agents.flatMap((agent) => [
              [`./${agent.name}`, `./agents/${agent.name}/agent/contract.ts`],
              [
                `./${agent.name}/secrets`,
                `./agents/${agent.name}/agent/secrets.ts`,
              ],
            ]),
          ),
          './*': './base/agentic/*.ts',
        },
      },
      'dependencies',
      { '@beruangai/agentforge': context.agentforgeSpecifier },
    ),
  );
}

/**
 * The project's `tsconfig.lib.json`: `agentforge-agent` among its custom conditions,
 * beside the workspace's own, and the base layer's package name mapped to its
 * modules — in the image the container workspace links it; in the host,
 * where the layers are not workspace members, this mapping does.
 */
export function projectTsconfig(context: RenderContext): MaintainedFile {
  const { project } = context;
  return maintainedJson(`${project.root}/tsconfig.lib.json`, (current) => {
    const compilerOptions = (current.compilerOptions ?? {}) as Record<
      string,
      unknown
    >;
    const conditions = (compilerOptions.customConditions as
      | string[]
      | undefined) ?? [...context.baseConditions];
    return {
      ...current,
      compilerOptions: {
        ...compilerOptions,
        customConditions: conditions.includes(AGENT_CONDITION)
          ? conditions
          : [...conditions, AGENT_CONDITION],
        paths: {
          ...(compilerOptions.paths as Record<string, string[]> | undefined),
          [`${basePackageName(project)}/*`]: ['./base/agentic/*.ts'],
        },
      },
    };
  });
}
