import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface LocalStoreExecutorOptions {
  /** Stops the shared store, keeping its data, instead of starting it. */
  readonly stop?: boolean;
}

/** One compose project on the machine, so every project shares one store. */
const COMPOSE_PROJECT = 'agentforge-store';
const COMPOSE_FILE = fileURLToPath(
  new URL('./compose/docker-compose.yml', import.meta.url),
);

/** The network the store's services are on, which a served agent joins. */
export const LOCAL_STORE_NETWORK = 'agentforge-store';
/** The store's endpoints, as an agent on its network reaches them. */
export const LOCAL_STORE_ENDPOINTS = {
  dynamoDB: 'http://dynamodb:8000',
  s3: 'http://s3:8333',
} as const;
/** The store's endpoints, as the host — a local worker or test — reaches them. */
export const LOCAL_STORE_HOST_ENDPOINTS = {
  dynamoDB: 'http://127.0.0.1:8000',
  s3: 'http://127.0.0.1:8333',
} as const;

/** The `docker` command for one run: up until healthy, unless running; or down, keeping its volumes. */
export function localStoreCommand(
  options: LocalStoreExecutorOptions,
): readonly string[] {
  return [
    'compose',
    '--project-name',
    COMPOSE_PROJECT,
    '--file',
    COMPOSE_FILE,
    ...(options.stop === true ? ['down'] : ['up', '--detach', '--wait']),
  ];
}

/**
 * The local store every project on the machine shares — DynamoDB Local and
 * SeaweedFS's S3, each in a named volume — started if it is not running, so
 * a served agent's tasks, transcripts and filesystems outlive its container.
 * With `stop`, takes it down, keeping its data.
 */
export default async function localStoreExecutor(
  options: LocalStoreExecutorOptions,
): Promise<{ success: boolean }> {
  const args = localStoreCommand(options);
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} exited ${result.status ?? result.signal}`,
    );
  }
  if (options.stop !== true) {
    console.log(
      `The local store serves DynamoDB at ${LOCAL_STORE_HOST_ENDPOINTS.dynamoDB} and S3 at ${LOCAL_STORE_HOST_ENDPOINTS.s3}`,
    );
  }
  return { success: true };
}
