import { relative } from 'node:path';
import type { TargetConfiguration, Tree } from '@nx/devkit';
import { readJson } from '@nx/devkit';
import {
  type AgenticProject,
  type Connected,
  connectedProjects,
  readAgenticProjects,
  type WorkflowProject,
} from '../project-record.ts';
import {
  agentforgeSpecifier,
  declaredVersion,
  dependencySpecifier,
} from '../workspace-dependencies.ts';
import {
  sharedConstructsKeys,
  workflowConstructExports,
  workflowProjectConstruct,
  workflowProjectConstructsIndex,
} from './constructs.ts';
import { basePackageName } from './layers.ts';
import {
  type MaintainedFile,
  maintainedHeader,
  maintainedJson,
  withEntries,
} from './maintained.ts';
import type { ProjectRendering } from './project-artifacts.ts';

const EXECUTOR = '@beruangai/agentforge';

/** What a workflow project's generated code imports from Temporal; each is a peer of AgentForge. */
export const WORKFLOW_PROJECT_TEMPORAL_PACKAGES = [
  '@temporalio/activity',
  '@temporalio/client',
  '@temporalio/common',
  '@temporalio/envconfig',
  '@temporalio/worker',
  '@temporalio/workflow',
] as const;

/**
 * What the worker's image installs: every Temporal package the worker bundle
 * leaves external. The core bridge is native, and `@temporalio/activity`'s
 * context must be the one copy the worker loads, or `activityInfo()` finds
 * no activity.
 */
export const WORKER_RUNTIME_PACKAGES = [
  '@temporalio/activity',
  '@temporalio/client',
  '@temporalio/common',
  '@temporalio/envconfig',
  '@temporalio/worker',
] as const;

/** The scaffolded test's server; released with the rest of the SDK, at the worker's range. */
export const TEMPORAL_TESTING = '@temporalio/testing';

/** The worker's image: its dependencies installed by Bun, run by Node on glibc (musl is unsupported). */
const BUN_IMAGE =
  'docker.io/oven/bun:1.4.0-alpine@sha256:07235578f79ef8c6f97d94aee7938e76f5cdba5f21ae5dbfdd3d3d38058437eb';
const NODE_IMAGE =
  'docker.io/library/node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1';

/** What rendering a workflow project reads beside its record. */
export interface WorkflowRenderContext {
  readonly project: WorkflowProject;
  /** Its connections, each with the agentic project it calls. */
  readonly connected: readonly Connected[];
  /** Every agentic project in the workspace: a maintained key names only the connected ones. */
  readonly agenticProjects: readonly AgenticProject[];
  readonly agentforgeSpecifier: string;
  /** How the host manifest declares each Temporal package: `catalog:`, or AgentForge's range. */
  readonly temporalSpecifiers: Readonly<Record<string, string>>;
  /** The version the worker's image declares each runtime package at: the workspace's own. */
  readonly workerVersions: Readonly<Record<string, string>>;
  /** Whether the workspace is ES modules, so relative imports carry `.js`. */
  readonly esm: boolean;
}

/** What rendering a workflow project reads from the workspace. */
export async function workflowRenderContext(
  tree: Tree,
  project: WorkflowProject,
): Promise<WorkflowRenderContext> {
  const agenticProjects = readAgenticProjects(tree);
  const temporalSpecifiers: Record<string, string> = {};
  for (const name of WORKFLOW_PROJECT_TEMPORAL_PACKAGES) {
    temporalSpecifiers[name] = await dependencySpecifier(tree, name);
  }
  const workerVersions: Record<string, string> = {};
  for (const name of WORKER_RUNTIME_PACKAGES) {
    workerVersions[name] = await declaredVersion(tree, name);
  }
  return {
    project,
    connected: connectedProjects(project, agenticProjects),
    agenticProjects,
    agentforgeSpecifier: agentforgeSpecifier(tree),
    temporalSpecifiers,
    workerVersions,
    esm: readJson<{ type?: unknown }>(tree, 'package.json').type === 'module',
  };
}

/** `<scope>-<project>`: the one task queue a workflow project's worker polls. */
export function taskQueue(project: WorkflowProject): string {
  return `${project.scope}-${project.projectName}`;
}

/** `GOLDEN_KATA`: how a rendered import names a connection's values. */
function upperSnake(connection: Connected['connection']): string {
  return connection.key
    .replace(/[A-Z]/g, (letter) => `_${letter}`)
    .toUpperCase();
}

/** The connections in a stable order, so a record's order changes nothing rendered. */
function sorted(context: WorkflowRenderContext): readonly Connected[] {
  return [...context.connected].sort((a, b) =>
    a.connection.key.localeCompare(b.connection.key),
  );
}

/**
 * The host manifest's maintained keys: its dependencies on AgentForge, the
 * Temporal packages and each connected agentic project — and on no agentic
 * project it is not connected to — and its exports: the client that starts
 * its workflows, and its secrets, which its construct is typed from.
 */
function workflowHostManifest(context: WorkflowRenderContext): MaintainedFile {
  const { project } = context;
  const connected = new Set(
    context.connected.map(({ connection }) => connection.packageName),
  );
  return maintainedJson(`${project.root}/package.json`, (current) => {
    const dependencies = Object.fromEntries(
      Object.entries(
        (current.dependencies ?? {}) as Record<string, string>,
      ).filter(
        ([name]) =>
          connected.has(name) ||
          !context.agenticProjects.some(
            (agentic) => agentic.packageName === name,
          ),
      ),
    );
    return withEntries(
      {
        ...current,
        exports: {
          ...((current.exports ?? {}) as Record<string, string>),
          './client': './client.ts',
          './secrets': './secrets.ts',
        },
        dependencies,
      },
      'dependencies',
      {
        '@beruangai/agentforge': context.agentforgeSpecifier,
        ...context.temporalSpecifiers,
        ...Object.fromEntries(
          [...connected].map((packageName) => [packageName, 'workspace:*']),
        ),
      },
    );
  });
}

/**
 * The project's `tsconfig.lib.json`: each connected agentic project's base
 * layer mapped to its modules, which the agents' contracts import by package
 * name — in the host, where the layers are not workspace members, this
 * mapping resolves them. No other agentic project's is kept.
 */
function workflowTsconfig(context: WorkflowRenderContext): MaintainedFile {
  const { project } = context;
  const baseKey = (agentic: AgenticProject) => `${basePackageName(agentic)}/*`;
  const everyBase = new Set(context.agenticProjects.map(baseKey));
  return maintainedJson(`${project.root}/tsconfig.lib.json`, (current) => {
    const compilerOptions = (current.compilerOptions ?? {}) as Record<
      string,
      unknown
    >;
    const kept = Object.entries(
      (compilerOptions.paths ?? {}) as Record<string, string[]>,
    ).filter(([key]) => !everyBase.has(key));
    const connected = sorted(context).map(({ agenticProject }) => [
      baseKey(agenticProject),
      [
        `${relativeDirectory(project.root, agenticProject.root)}/base/agentic/*.ts`,
      ],
    ]);
    const paths = Object.fromEntries([...kept, ...connected]);
    const { paths: _paths, ...rest } = compilerOptions;
    return {
      ...current,
      compilerOptions:
        Object.keys(paths).length === 0 ? rest : { ...rest, paths },
    };
  });
}

/** `to` from `from`, as a tsconfig path: `../golden-kata`, or `./nested`. */
function relativeDirectory(from: string, to: string): string {
  const path = relative(from, to);
  return path.startsWith('.') ? path : `./${path}`;
}

/** The worker's entry: AgentForge's worker over the project's workflows and activities. */
function workerEntry(project: WorkflowProject): MaintainedFile {
  return {
    path: `${project.root}/worker.ts`,
    render: () => `${maintainedHeader('//')}
//
// The worker's entry: AgentForge's worker polling the project's task queue
// with its workflows, bundled before it starts, its own activities and every
// connected agentic project's, requiring the secrets secrets.ts declares.
// The Temporal connection, and how agents are reached, come from the
// environment.
import { runWorker } from '@beruangai/agentforge/temporal';
import { activities } from './activities/index.ts';
import { agentActivities } from './agents/activities.ts';
import { TASK_QUEUE } from './client.ts';
import { REQUIRED_SECRETS } from './secrets.ts';

await runWorker({
  taskQueue: TASK_QUEUE,
  workflowBundle: new URL('./workflows.js', import.meta.url),
  activities,
  agentActivities: await agentActivities(),
  requiredSecrets: REQUIRED_SECRETS,
});
`,
  };
}

/** How a caller starts the project's workflows: its task queue and a connected client. */
function workflowClient(project: WorkflowProject): MaintainedFile {
  return {
    path: `${project.root}/client.ts`,
    render: () => `${maintainedHeader('//')}
//
// How a caller starts ${project.projectName}'s workflows: the task queue its worker
// polls, and a Temporal client connected as the environment names it.
import { connectTemporalClient } from '@beruangai/agentforge/temporal';
import type { Client } from '@temporalio/client';

/** The one task queue the project's worker polls. */
export const TASK_QUEUE = '${taskQueue(project)}';

/** A client from TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE and, for Temporal Cloud, TEMPORAL_API_KEY. */
export const connectClient = (): Promise<Client> => connectTemporalClient();
`,
  };
}

/**
 * The worker's side of the connections: every procedure of every connected
 * project's agents as an activity over that project's client.
 */
function agentActivitiesModule(context: WorkflowRenderContext): MaintainedFile {
  const { project } = context;
  const connected = sorted(context);
  const imports = connected.map(
    ({ connection }) => `import {
  CONTRACTS as ${upperSnake(connection)}_CONTRACTS,
  client as ${connection.key}Client,
} from '${connection.packageName}/client';`,
  );
  const body =
    connected.length === 0
      ? `  // No connections yet: the setting is checked all the same.
  agentsFromEnvironment();
  return Promise.resolve({});`
      : `  const agents = agentsFromEnvironment();
  return {
${connected
  .map(
    ({ connection }) => `    ...projectActivities(
      '${connection.key}',
      ${upperSnake(connection)}_CONTRACTS,
      agents.kind === 'local'
        ? ${connection.key}Client.local()
        : await ${connection.key}Client.fromRuntimeConfig(agents),
    ),`,
  )
  .join('\n')}
  };`;
  return {
    path: `${project.root}/agents/activities.ts`,
    render: () => `${maintainedHeader('//')}
//
// The worker's side of the connections: every procedure of every connected
// agentic project's agents as an activity, \`<project>.<agent>.<Procedure>\`,
// over that project's client — each agent in its local container or on
// AgentCore, as AGENTFORGE_AGENTS names.
import {
  agentsFromEnvironment,
  type ProjectActivity,
${connected.length === 0 ? '' : '  projectActivities,\n'}} from '@beruangai/agentforge/temporal';
${imports.join('\n')}

/** Every connected agent's procedures, as the worker registers them. */
export ${connected.length === 0 ? '' : 'async '}function agentActivities(): Promise<
  Readonly<Record<string, ProjectActivity>>
> {
${body}
}
`,
  };
}

/**
 * The workflow side of the connections: each connected project's agents as
 * calls typed by their contracts, imported as types only.
 */
function agentWorkflowModule(context: WorkflowRenderContext): MaintainedFile {
  const { project } = context;
  const connected = sorted(context);
  const imports = connected.map(
    ({ connection }) =>
      `import type { CONTRACTS as ${upperSnake(connection)}_CONTRACTS } from '${connection.packageName}/client';`,
  );
  return {
    path: `${project.root}/agents/workflow.ts`,
    render: () => `${maintainedHeader('//')}
//
// The workflow side of the connections: each connected agentic project's
// agents as calls typed by their contracts — imported as types only, so the
// workflow bundle carries none of their code.
${connected.length === 0 ? '' : "import { proxyProject } from '@beruangai/agentforge/temporal/workflow';\n"}import type { ActivityOptions } from '@temporalio/workflow';
${imports.join('\n')}

/**
 * Each connected project's agents, \`agents().<project>.<agent>.<Procedure>(input,
 * { runtimeSessionId })\`; \`options\` merge over AgentForge's defaults.
 */
export const agents = (${connected.length === 0 ? '_options' : 'options'}?: ActivityOptions) => ({
${connected
  .map(
    ({ connection }) =>
      `  ${connection.key}: proxyProject<typeof ${upperSnake(connection)}_CONTRACTS>(
    '${connection.key}',
    options,
  ),`,
  )
  .join('\n')}
});
`,
  };
}

/**
 * The worker's image: the Temporal packages installed frozen from the lock
 * `lock` writes, on Node — never Bun — with the worker and its workflows.
 */
function workerDockerfile(project: WorkflowProject): MaintainedFile {
  return {
    path: `${project.root}/container/Dockerfile`,
    render: () => `${maintainedHeader('#')}
#
# The worker's image. Its build context is the project's \`bundle\` output:
# worker.mjs, workflows.js, and this directory's package.json and bun.lock.
# Bun installs the Temporal packages the bundle leaves external; Node runs it.
ARG BUN_IMAGE=${BUN_IMAGE}
ARG NODE_IMAGE=${NODE_IMAGE}

FROM \${BUN_IMAGE} AS dependencies
WORKDIR /worker
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM \${NODE_IMAGE}
WORKDIR /worker
COPY --from=dependencies /worker/node_modules ./node_modules
COPY package.json worker.mjs workflows.js ./
USER node
CMD ["node", "worker.mjs"]
`,
  };
}

/** The worker image's manifest: exactly the runtime packages, at the workspace's versions. */
function workerManifest(context: WorkflowRenderContext): MaintainedFile {
  const { project } = context;
  return maintainedJson(
    `${project.root}/container/package.json`,
    (current) => ({
      ...current,
      name: `${project.packageName}-worker`,
      private: true,
      type: 'module',
      dependencies: { ...context.workerVersions },
    }),
  );
}

/**
 * The project's targets: the workflow bundle, the worker's lock and bundle
 * (the image's build context), a local Temporal server, the worker served
 * against it, and the unit tests against the same server's binary.
 */
export function workflowProjectTargets(): Record<string, TargetConfiguration> {
  const bundle = '{workspaceRoot}/dist/{projectRoot}/bundle';
  return {
    'bundle-workflows': {
      executor: `${EXECUTOR}:bundle-workflows`,
      cache: true,
      inputs: [
        'production',
        '^production',
        { externalDependencies: ['@temporalio/worker'] },
      ],
      outputs: [`${bundle}/workflows.js`],
    },
    lock: {
      executor: `${EXECUTOR}:lock`,
      cache: true,
      dependsOn: ['^bundle'],
      inputs: [
        '{projectRoot}/container/package.json',
        '{workspaceRoot}/bun.lock',
        { runtime: 'bun --version' },
      ],
      outputs: ['{projectRoot}/container/bun.lock'],
      options: { layer: 'worker' },
    },
    bundle: {
      executor: `${EXECUTOR}:bundle-worker`,
      cache: true,
      dependsOn: ['bundle-workflows', 'lock', '^bundle'],
      inputs: ['production', '^production', { runtime: 'bun --version' }],
      outputs: [
        `${bundle}/worker.mjs`,
        `${bundle}/Dockerfile`,
        `${bundle}/package.json`,
        `${bundle}/bun.lock`,
      ],
    },
    assemble: {
      executor: 'nx:noop',
      dependsOn: ['bundle'],
    },
    'temporal-server': {
      executor: 'nx:run-commands',
      continuous: true,
      options: {
        command:
          // biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's expansion, failing on an unset namespace
          'mkdir -p dist/{projectRoot}/temporal-server && temporal server start-dev --db-filename dist/{projectRoot}/temporal-server/temporal.db --namespace "${TEMPORAL_NAMESPACE:?TEMPORAL_NAMESPACE is unset}"',
      },
    },
    // Run as the image runs it: the bundle beside the Temporal packages its
    // lock pins, installed apart from the build context, which stays free of
    // node_modules. Nx loads .env.serve.local for the target, and
    // .env.hybrid.local for the hybrid configuration: the project's secrets,
    // and hybrid's AGENTFORGE_AGENTS and AWS credentials. Never a
    // TEMPORAL_API_KEY: the worker refuses one aimed at a local server.
    serve: {
      executor: 'nx:run-commands',
      continuous: true,
      dependsOn: ['bundle', 'temporal-server'],
      options: {
        command:
          'rm -rf dist/{projectRoot}/serve && cp -R dist/{projectRoot}/bundle dist/{projectRoot}/serve && bun install --cwd dist/{projectRoot}/serve --frozen-lockfile --production && node dist/{projectRoot}/serve/worker.mjs',
        env: { TEMPORAL_ADDRESS: 'localhost:7233' },
      },
      defaultConfiguration: 'local',
      configurations: {
        local: {
          env: {
            TEMPORAL_ADDRESS: 'localhost:7233',
            AGENTFORGE_AGENTS: 'local',
          },
        },
        hybrid: {},
      },
    },
    test: {
      executor: 'nx:run-commands',
      cache: true,
      inputs: [
        'default',
        '^production',
        { runtime: 'node --version' },
        { runtime: 'temporal --version' },
      ],
      options: {
        command: 'vitest run --config vitest.unit.mts',
        cwd: '{projectRoot}',
      },
    },
  };
}

/** Every artifact AgentForge maintains for a workflow project. */
export function workflowProjectArtifacts(context: WorkflowRenderContext) {
  const { project } = context;
  return {
    files: [
      workflowHostManifest(context),
      workflowTsconfig(context),
      workerEntry(project),
      workflowClient(project),
      agentActivitiesModule(context),
      agentWorkflowModule(context),
      workerDockerfile(project),
      workerManifest(context),
      workflowProjectConstruct(context),
      workflowProjectConstructsIndex(context),
      ...workflowConstructExports(context),
      ...sharedConstructsKeys({
        agentforgeSpecifier: context.agentforgeSpecifier,
        project,
      }),
    ],
    targets: workflowProjectTargets(),
  };
}

/** A workflow project's rendering; its targets do not vary, so none goes stale. */
export async function workflowProjectRendering(
  tree: Tree,
  project: WorkflowProject,
): Promise<ProjectRendering> {
  return {
    name: project.name,
    detached: project.detached,
    artifacts: workflowProjectArtifacts(
      await workflowRenderContext(tree, project),
    ),
    isStaleTarget: () => false,
  };
}
