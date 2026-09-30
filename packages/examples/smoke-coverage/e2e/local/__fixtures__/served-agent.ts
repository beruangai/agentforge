import { execFile, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SMOKE_COVERAGE_CONTAINER_NAMES } from '../../../client.ts';

const run = promisify(execFile);
const SERVING_TIMEOUT_MILLISECONDS = 120_000;

/** hello-agent's container, as `serve-hello-agent` runs it. */
export const CONTAINER = SMOKE_COVERAGE_CONTAINER_NAMES.helloAgent;

/** The container's published contract port, as the host reaches it. */
export async function servedUrl(): Promise<URL> {
  const { stdout } = await run('docker', ['port', CONTAINER, '9000/tcp']);
  const address = stdout.trim().split('\n')[0];
  if (!address) throw new Error(`${CONTAINER} publishes no port 9000`);
  return new URL(`http://${address.replace(/^0\.0\.0\.0:/, '127.0.0.1:')}/`);
}

/**
 * Until the container answers `/ping`. Nx starts the e2e once
 * `serve-hello-agent` has started, not once it serves, so the caller waits.
 */
export async function untilServing(): Promise<void> {
  const deadline = Date.now() + SERVING_TIMEOUT_MILLISECONDS;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL('/ping', await servedUrl()));
      if (response.ok) return;
      lastFailure = new Error(`/ping answered ${response.status}`);
    } catch (error) {
      lastFailure = error;
    }
    await sleep(1_000);
  }
  throw new Error(
    `${CONTAINER} did not serve within ${SERVING_TIMEOUT_MILLISECONDS} ms`,
    { cause: lastFailure },
  );
}

/** The container's stdout and stderr together, as `docker logs` splits them. */
export function logs(): string {
  const result = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
  return `${result.stdout}${result.stderr}`;
}
