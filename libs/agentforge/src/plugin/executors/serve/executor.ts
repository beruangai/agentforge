import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExecutorContext } from '@nx/devkit';
import { z } from 'zod';
import { AGENT_IMAGE_VARIABLE } from '#core/agent-image.ts';
import {
  FILESYSTEM_BUCKETS_VARIABLE,
  parseDeclaredBuckets,
} from '#core/filesystem.ts';
import { S3_ENDPOINT_VARIABLE } from '#core/s3-endpoint.ts';
import { SecretNameSchema } from '#core/secrets.ts';
import { SESSION_BUCKET_VARIABLE } from '#core/session-store.ts';
import { frameworkPlugin } from '#framework/registry.ts';
import { agentSecretsFile, baseSecretsFile } from '../../artifacts/layers.ts';
import { imageIdFile } from '../../container/images.ts';
import { scopeOf } from '../../names.ts';
import type { AgenticProject } from '../../project-record.ts';
import { executorProject } from '../executor-project.ts';
import {
  LOCAL_STORE_ENDPOINTS,
  LOCAL_STORE_HOST_ENDPOINTS,
  LOCAL_STORE_NETWORK,
} from '../local-store/executor.ts';

export interface ServeExecutorOptions {
  readonly agent: string;
}
/** The agent's contract port inside its container. */
const AGENT_PORT = 9000;

/**
 * What serving one agent starts: the agent under its container name, on the
 * local store's network, run by its image's id, with each secret it requires
 * passed by name from the executor's environment; its project's task table
 * and session bucket in the store, and the filesystem buckets the
 * environment declares.
 */
export interface ServePlan {
  readonly agent: string;
  /** The id the agent's image build wrote, which the container runs by and every task records. */
  readonly image: string;
  readonly secrets: readonly string[];
  readonly tableName: string;
  readonly sessionBucket: string;
  readonly filesystemBuckets: Readonly<Record<string, string>>;
}

/** `@proj/golden-kata` → `proj-golden-kata`: what the project's table and bucket in the local store are named by. */
function storeName(packageName: string): string {
  return `${scopeOf(packageName)}-${packageName.slice(packageName.indexOf('/') + 1)}`;
}

/**
 * The agent's secrets: its framework's, then `declared` — its layers'
 * `REQUIRED_SECRETS`; `image` is the id its image build wrote; `environment`
 * may declare filesystem buckets, as `AGENTFORGE_FILESYSTEM_BUCKETS`.
 */
export function servePlan(
  project: AgenticProject,
  agentName: string,
  declared: readonly string[],
  image: string,
  environment: NodeJS.ProcessEnv = {},
): ServePlan {
  const agent = project.agents.find((recorded) => recorded.name === agentName);
  if (agent === undefined) {
    throw new Error(
      `${project.name} records no agent ${agentName}: it records ${
        project.agents.map((recorded) => recorded.name).join(', ') || 'none'
      }`,
    );
  }
  const name = storeName(project.name);
  return {
    agent: agent.containerName,
    image,
    secrets: [
      ...new Set([
        ...frameworkPlugin(project.framework).requiredSecrets,
        ...declared,
      ]),
    ],
    tableName: `${name}-tasks`,
    sessionBucket: `${name}-sessions`,
    filesystemBuckets: parseDeclaredBuckets(
      environment[FILESYSTEM_BUCKETS_VARIABLE],
    ),
  };
}

/**
 * The id the agent's image build wrote, so the container runs the image
 * built, even if its tag has moved since.
 */
export function builtImageId(
  workspaceRoot: string,
  project: AgenticProject,
  agentName: string,
): string {
  const file = join(
    workspaceRoot,
    imageIdFile(project.root, `agents/${agentName}`),
  );
  if (!existsSync(file)) {
    throw new Error(
      `${file} is missing: build the agent's image first, with nx run ${project.name}:image-${agentName}`,
    );
  }
  return readFileSync(file, 'utf8').trim();
}

const RequiredSecretsSchema = z.array(SecretNameSchema).readonly();

/** A layer's `REQUIRED_SECRETS`, imported from its `secrets.ts`. */
async function requiredSecretsOf(file: string): Promise<readonly string[]> {
  const module = (await import(pathToFileURL(file).href)) as {
    REQUIRED_SECRETS?: unknown;
  };
  const parsed = RequiredSecretsSchema.safeParse(module.REQUIRED_SECRETS);
  if (!parsed.success) {
    throw new Error(
      `${file} must export REQUIRED_SECRETS, an array of environment variable names: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/** What the agent's layers require: the base layer's secrets, then the agent's own. */
export async function declaredSecrets(
  workspaceRoot: string,
  project: AgenticProject,
  agentName: string,
): Promise<readonly string[]> {
  return [
    ...(await requiredSecretsOf(join(workspaceRoot, baseSecretsFile(project)))),
    ...(await requiredSecretsOf(
      join(workspaceRoot, agentSecretsFile(project, { name: agentName })),
    )),
  ];
}

/** A container's state, as `docker container inspect` finds it. */
export type ContainerState = 'running' | 'stopped' | 'absent';

/** Why serving must not start, before anything is started; undefined when it may. */
export function serveRefusal(
  plan: ServePlan,
  environment: NodeJS.ProcessEnv,
  stateOf: (container: string) => ContainerState,
): string | undefined {
  const missing = plan.secrets.filter((name) => !environment[name]);
  if (missing.length > 0) {
    return `${missing.join(', ')} not set; the serve configuration loads the agent's secrets from .env.serve.local`;
  }
  const state = stateOf(plan.agent);
  if (state === 'running') {
    return `${plan.agent} is already being served`;
  }
  if (state === 'stopped') {
    return `a stopped container named ${plan.agent} exists; remove it with docker rm ${plan.agent}`;
  }
  return undefined;
}

/** The buckets the agent needs in the local store: its project's sessions, and each filesystem's. */
export function storeBuckets(plan: ServePlan): readonly string[] {
  return [
    ...new Set([plan.sessionBucket, ...Object.values(plan.filesystemBuckets)]),
  ];
}

/** The `docker` command that starts the agent against the local store. */
export function startCommand(plan: ServePlan): readonly string[] {
  return [
    'run',
    '--detach',
    '--name',
    plan.agent,
    '--network',
    LOCAL_STORE_NETWORK,
    '--publish',
    `127.0.0.1::${AGENT_PORT}`,
    ...plan.secrets.flatMap((name) => ['--env', name]),
    '--env',
    `AGENTFORGE_TABLE_NAME=${plan.tableName}`,
    '--env',
    `AGENTFORGE_DYNAMODB_ENDPOINT=${LOCAL_STORE_ENDPOINTS.dynamoDB}`,
    '--env',
    `${S3_ENDPOINT_VARIABLE}=${LOCAL_STORE_ENDPOINTS.s3}`,
    '--env',
    `${SESSION_BUCKET_VARIABLE}=${plan.sessionBucket}`,
    ...(Object.keys(plan.filesystemBuckets).length === 0
      ? []
      : [
          '--env',
          `${FILESYSTEM_BUCKETS_VARIABLE}=${JSON.stringify(plan.filesystemBuckets)}`,
        ]),
    '--env',
    'AWS_ACCESS_KEY_ID=local',
    '--env',
    'AWS_SECRET_ACCESS_KEY=local',
    '--env',
    'AWS_REGION=us-east-2',
    '--env',
    `${AGENT_IMAGE_VARIABLE}=${plan.image}`,
    plan.image,
  ];
}

/** The `docker` command that removes the agent's container; the store keeps its data. */
export function cleanupCommand(plan: ServePlan): readonly string[] {
  return ['rm', '--force', plan.agent];
}

/** Creates a bucket in the local store, which keeps one that exists. */
async function createStoreBucket(bucket: string): Promise<void> {
  const response = await fetch(
    new URL(`/${bucket}`, LOCAL_STORE_HOST_ENDPOINTS.s3),
    { method: 'PUT' },
  );
  if (!response.ok && response.status !== 409) {
    throw new Error(
      `the local store refused bucket ${bucket}: ${response.status} ${await response.text()}`,
    );
  }
}

function docker(args: readonly string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} exited ${result.status ?? result.signal}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

function containerState(container: string): ContainerState {
  const result = spawnSync(
    'docker',
    ['container', 'inspect', '--format', '{{.State.Running}}', container],
    { encoding: 'utf8' },
  );
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) return 'absent';
  return result.stdout.trim() === 'true' ? 'running' : 'stopped';
}

function publishedUrl(container: string, port: number): string {
  const address = docker(['port', container, `${port}/tcp`]).split('\n')[0];
  if (!address) throw new Error(`${container} publishes no port ${port}`);
  return `http://${address.replace(/^0\.0\.0\.0:/, '127.0.0.1:')}/`;
}

async function until(
  description: string,
  deadlineMilliseconds: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + deadlineMilliseconds;
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

const answers = (url: string, ok: (response: Response) => boolean) => () =>
  fetch(url).then(ok, () => false);

/**
 * Serves an agent's image locally until stopped, against the local store the
 * `local-store` target starts: its buckets created there, the agent under its
 * container name on the store's network, on a port the host assigns, its
 * logs followed. Continuous: ready once the agent answers `/ping`, and
 * removing its container — never the store's data — when stopped or when the
 * agent exits.
 */
export default async function* serveExecutor(
  options: ServeExecutorOptions,
  context: ExecutorContext,
): AsyncGenerator<{ success: boolean }> {
  const project = executorProject(context);
  const plan = servePlan(
    project,
    options.agent,
    await declaredSecrets(context.root, project, options.agent),
    builtImageId(context.root, project, options.agent),
    process.env,
  );
  const refusal = serveRefusal(plan, process.env, containerState);
  if (refusal !== undefined) throw new Error(refusal);
  const cleanup = () => {
    spawnSync('docker', cleanupCommand(plan), { stdio: 'ignore' });
  };
  const stop = () => {
    cleanup();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', cleanup);
  try {
    // The local-store target has the store up; the server creates its table.
    for (const bucket of storeBuckets(plan)) await createStoreBucket(bucket);
    docker(startCommand(plan));
    const url = publishedUrl(plan.agent, AGENT_PORT);
    await until(
      `${plan.agent} to answer /ping`,
      60_000,
      answers(new URL('/ping', url).href, (response) => response.ok),
    );
    console.log(`${plan.agent} serves at ${url}`);
    yield { success: true };
    const logs = spawn('docker', ['logs', '--follow', plan.agent], {
      stdio: 'inherit',
    });
    const exit = await new Promise<number | null>((resolve, reject) => {
      logs.once('error', reject);
      logs.once('exit', resolve);
    });
    throw new Error(`${plan.agent} stopped (docker logs exited ${exit})`);
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    process.off('exit', cleanup);
    cleanup();
  }
}
