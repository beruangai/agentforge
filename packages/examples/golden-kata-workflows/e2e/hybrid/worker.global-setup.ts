/**
 * The hybrid run's worker: the `bundle` output installed as the image and
 * `serve` install it, run by Node against the shared local server, reaching
 * golden-kata's agents on AgentCore through the runtime configuration that
 * golden-kata-infra's `deploy` recorded — as the test role, which `.env.integ`
 * names. The suite waits for it to poll; its errors print here.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { cp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const WORKSPACE_ROOT = fileURLToPath(
  new URL('../../../../../', import.meta.url),
);
const BUNDLE = `${WORKSPACE_ROOT}dist/packages/examples/golden-kata-workflows/bundle`;
const WORKER = `${WORKSPACE_ROOT}dist/packages/examples/golden-kata-workflows/e2e-hybrid`;
const OUTPUTS_FILE = `${WORKSPACE_ROOT}dist/packages/examples/golden-kata-infra/deploy/outputs.json`;
const STACK_NAME = 'agentforge-example-golden-kata-Application';
const STOP_TIMEOUT_MILLISECONDS = 30_000;

async function runtimeConfigApplicationId(): Promise<string> {
  const outputs: unknown = JSON.parse(await readFile(OUTPUTS_FILE, 'utf8'));
  const applicationId = (
    outputs as Record<string, Record<string, unknown> | undefined>
  )[STACK_NAME]?.RuntimeConfigApplicationId;
  if (typeof applicationId !== 'string') {
    throw new Error(
      `${OUTPUTS_FILE} records no ${STACK_NAME} RuntimeConfigApplicationId: deploy golden-kata-infra first`,
    );
  }
  return applicationId;
}

async function stop(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) return;
  const exited = new Promise((resolve) => worker.once('exit', resolve));
  worker.kill('SIGTERM');
  const timer = setTimeout(
    () => worker.kill('SIGKILL'),
    STOP_TIMEOUT_MILLISECONDS,
  );
  await exited;
  clearTimeout(timer);
}

export default async function setup(): Promise<() => Promise<void>> {
  const applicationId = await runtimeConfigApplicationId();
  await rm(WORKER, { recursive: true, force: true });
  await cp(BUNDLE, WORKER, { recursive: true });
  execFileSync(
    'bun',
    ['install', '--cwd', WORKER, '--frozen-lockfile', '--production'],
    { stdio: 'inherit' },
  );
  const worker = spawn('node', [`${WORKER}/worker.mjs`], {
    stdio: 'inherit',
    env: {
      ...process.env,
      AGENTFORGE_AGENTS: `runtime-config:${applicationId}`,
    },
  });
  let stopping = false;
  worker.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`the hybrid worker exited early (${code ?? signal})`);
    }
  });
  return () => {
    stopping = true;
    return stop(worker);
  };
}
