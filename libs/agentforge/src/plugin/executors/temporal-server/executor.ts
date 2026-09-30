import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface TemporalServerExecutorOptions {
  /** Stops the shared server, keeping its data, instead of starting it. */
  readonly stop?: boolean;
}

/** One compose project on the machine, so every project shares one server. */
const COMPOSE_PROJECT = 'agentforge-temporal';
const COMPOSE_FILE = fileURLToPath(
  new URL('./compose/docker-compose.yml', import.meta.url),
);
const ADDRESS = 'localhost:7233';
const UI = 'http://localhost:8233';

const compose = (...args: string[]): readonly string[] => [
  'compose',
  '--project-name',
  COMPOSE_PROJECT,
  '--file',
  COMPOSE_FILE,
  ...args,
];

/**
 * The `docker` commands for one run: starting brings the server up unless it
 * is running and waits until it is healthy, then registers the namespace
 * unless it exists; stopping takes it down and keeps its volumes.
 */
export function temporalServerCommands(
  options: TemporalServerExecutorOptions,
  environment: NodeJS.ProcessEnv,
): readonly (readonly string[])[] {
  if (options.stop === true) return [compose('down')];
  const namespace = environment.TEMPORAL_NAMESPACE;
  if (!namespace) {
    throw new Error(
      'TEMPORAL_NAMESPACE is not set; the workspace .env names the namespace to register on the local server',
    );
  }
  return [
    compose('up', '--detach', '--wait'),
    // The namespace reaches the container by name, from this environment.
    compose('run', '--rm', 'temporal-create-namespace'),
  ];
}

/**
 * The local Temporal server every project on the machine shares — PostgreSQL
 * and Elasticsearch, each in a named volume, with the web UI — started if it
 * is not running, with `TEMPORAL_NAMESPACE` registered on it; a target
 * depends on this one to have both. With `stop`, takes the server down,
 * keeping its data.
 */
export default async function temporalServerExecutor(
  options: TemporalServerExecutorOptions,
): Promise<{ success: boolean }> {
  for (const args of temporalServerCommands(options, process.env)) {
    const result = spawnSync('docker', args, { stdio: 'inherit' });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `docker ${args.join(' ')} exited ${result.status ?? result.signal}`,
      );
    }
  }
  if (options.stop !== true) {
    console.log(
      `Temporal serves ${process.env.TEMPORAL_NAMESPACE} at ${ADDRESS}, its UI at ${UI}`,
    );
  }
  return { success: true };
}
