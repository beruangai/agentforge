/** golden-kata's agents in their local containers, as `serve-writer` and `serve-grader` run them. */
import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { beforeAll } from 'vitest';
import {
  CONTAINER_NAMES as GOLDEN_KATA_CONTAINER_NAMES,
  client as goldenKataClient,
} from '../../client.ts';
import { goldenKataSuite } from '../golden-kata.suite.ts';

const run = promisify(execFile);
const SERVING_TIMEOUT_MILLISECONDS = 120_000;

/**
 * Until the container answers `/ping`. Nx starts this target once the
 * `serve-*` tasks have started, not once they serve, so the caller waits.
 */
async function untilServing(containerName: string): Promise<void> {
  const deadline = Date.now() + SERVING_TIMEOUT_MILLISECONDS;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await run('docker', [
        'port',
        containerName,
        '9000/tcp',
      ]);
      const address = stdout
        .trim()
        .split('\n')[0]
        ?.replace('0.0.0.0', '127.0.0.1');
      const response = await fetch(`http://${address}/ping`);
      if (response.ok) return;
      lastFailure = new Error(`/ping answered ${response.status}`);
    } catch (error) {
      lastFailure = error;
    }
    await sleep(1_000);
  }
  throw new Error(
    `${containerName} did not serve within ${SERVING_TIMEOUT_MILLISECONDS} ms`,
    { cause: lastFailure },
  );
}

beforeAll(async () => {
  await Promise.all(
    Object.values(GOLDEN_KATA_CONTAINER_NAMES).map(untilServing),
  );
}, SERVING_TIMEOUT_MILLISECONDS + 10_000);

goldenKataSuite(() => goldenKataClient.local());
