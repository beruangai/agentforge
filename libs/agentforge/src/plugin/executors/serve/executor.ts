import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExecutorContext } from '@nx/devkit';
import { z } from 'zod';
import { AGENT_IMAGE_VARIABLE } from '#core/agent-image.ts';
import { REQUIRED_SECRETS, SecretNameSchema } from '#core/secrets.ts';
import { agentSecretsFile, baseSecretsFile } from '../../artifacts/layers.ts';
import { imageIdFile } from '../../container/images.ts';
import type { AgenticProject } from '../../project-record.ts';
import { executorProject } from '../executor-project.ts';

export interface ServeExecutorOptions {
  readonly agent: string;
}
const DYNAMODB_LOCAL_IMAGE =
  'amazon/dynamodb-local:3.1.0@sha256:7ef4a2c45b58c2901e70a4f28e0953a422c2c631baaaf5e2c15e0805740c7752';
/** The agent's contract port inside its container. */
const AGENT_PORT = 9000;
const DYNAMODB_PORT = 8000;
const TABLE_NAME = 'agentforge-tasks';

/**
 * What serving one agent starts: a private network, DynamoDB Local, and the
 * agent under its container name, run by its image's id, with each secret it
 * requires passed by name from the executor's environment.
 */
export interface ServePlan {
  readonly network: string;
  readonly dynamoDB: string;
  readonly agent: string;
  /** The id the agent's image build wrote, which the container runs by and every task records. */
  readonly image: string;
  readonly secrets: readonly string[];
}

/**
 * The agent's secrets: AgentForge's own, then `declared` — its layers'
 * `REQUIRED_SECRETS`; `image` is the id its image build wrote.
 */
export function servePlan(
  project: AgenticProject,
  agentName: string,
  declared: readonly string[],
  image: string,
): ServePlan {
  const agent = project.agents.find((recorded) => recorded.name === agentName);
  if (agent === undefined) {
    throw new Error(
      `${project.name} records no agent ${agentName}: it records ${
        project.agents.map((recorded) => recorded.name).join(', ') || 'none'
      }`,
    );
  }
  return {
    network: agent.containerName,
    dynamoDB: `${agent.containerName}-dynamodb`,
    agent: agent.containerName,
    image,
    secrets: [...new Set([...REQUIRED_SECRETS, ...declared])],
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

/** The `docker` commands that start DynamoDB Local, then the agent. */
export function startCommands(plan: ServePlan): {
  readonly network: readonly string[];
  readonly dynamoDB: readonly string[];
  readonly agent: readonly string[];
} {
  return {
    network: ['network', 'create', plan.network],
    dynamoDB: [
      'run',
      '--detach',
      '--name',
      plan.dynamoDB,
      '--network',
      plan.network,
      '--publish',
      `127.0.0.1::${DYNAMODB_PORT}`,
      DYNAMODB_LOCAL_IMAGE,
      '-jar',
      'DynamoDBLocal.jar',
      '-inMemory',
      '-sharedDb',
    ],
    agent: [
      'run',
      '--detach',
      '--name',
      plan.agent,
      '--network',
      plan.network,
      '--publish',
      `127.0.0.1::${AGENT_PORT}`,
      ...plan.secrets.flatMap((name) => ['--env', name]),
      '--env',
      `AGENTFORGE_TABLE_NAME=${TABLE_NAME}`,
      '--env',
      `AGENTFORGE_DYNAMODB_ENDPOINT=http://${plan.dynamoDB}:${DYNAMODB_PORT}`,
      '--env',
      'AWS_ACCESS_KEY_ID=local',
      '--env',
      'AWS_SECRET_ACCESS_KEY=local',
      '--env',
      'AWS_REGION=us-east-2',
      '--env',
      `${AGENT_IMAGE_VARIABLE}=${plan.image}`,
      plan.image,
    ],
  };
}

/** The `docker` commands that remove everything serving started. */
export function cleanupCommands(
  plan: ServePlan,
): readonly (readonly string[])[] {
  return [
    ['rm', '--force', plan.agent, plan.dynamoDB],
    ['network', 'rm', plan.network],
  ];
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
 * Serves an agent's image locally until stopped: DynamoDB Local beside it on
 * a private network, the agent under its container name on a port the host
 * assigns, its logs followed. Continuous: ready once the agent answers
 * `/ping`, and removing its containers and network when stopped or when the
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
  );
  const refusal = serveRefusal(plan, process.env, containerState);
  if (refusal !== undefined) throw new Error(refusal);
  const cleanup = () => {
    for (const args of cleanupCommands(plan)) {
      spawnSync('docker', args, { stdio: 'ignore' });
    }
  };
  const stop = () => {
    cleanup();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.once('exit', cleanup);
  try {
    const commands = startCommands(plan);
    docker(commands.network);
    docker(commands.dynamoDB);
    // The server creates its table as it starts, so DynamoDB Local must be
    // listening first. Any HTTP answer, even a 400, means it is.
    await until(
      'DynamoDB Local',
      30_000,
      answers(publishedUrl(plan.dynamoDB, DYNAMODB_PORT), () => true),
    );
    docker(commands.agent);
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
