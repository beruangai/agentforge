/**
 * A real worker against the Temporal CLI's dev server, over a scripted
 * procedure client: what the design relies on and the SDK documents thinly
 * (ADR 0016). A worker shut down mid-activity leaves the agent's task running
 * and the retry attaches to it under the same idempotency key; only a cancel
 * the workflow requests cancels the task; `runWorker` exits on SIGTERM inside
 * its grace.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  bundleWorkflowCode,
  Worker as TemporalWorker,
  type Worker,
} from '@temporalio/worker';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type {
  ProcedureClient,
  Starting,
  TaskView,
} from '../../../src/client/client.ts';
import { projectActivities } from '../../../src/client/temporal/project-activities.ts';
import { CONTRACTS } from './__fixtures__/contract.ts';

const TASK = {
  taskId: 'task',
  contextId: 'context',
  attempt: 1,
  image: 'image',
  runs: [],
};
const WORKING: TaskView<string> = { ...TASK, state: 'TASK_STATE_WORKING' };
const COMPLETED: TaskView<string> = {
  ...TASK,
  state: 'TASK_STATE_COMPLETED',
  output: 'answered',
};

const starts: Starting[] = [];
/** The start that answers the task completed — an attach finding it done. */
let completedFromStart = Number.POSITIVE_INFINITY;
const sendMessage = vi.fn<
  ProcedureClient<{ text: string }, string>['SendMessage']
>(async (_input, starting) => {
  starts.push(starting);
  return starts.length >= completedFromStart ? COMPLETED : WORKING;
});
const getTask = vi.fn<ProcedureClient<{ text: string }, string>['GetTask']>(
  async () => WORKING,
);
const cancelTask = vi.fn(async () => ({
  ...TASK,
  state: 'TASK_STATE_CANCELED' as const,
}));
const ACTIVITIES = projectActivities(
  'fixture',
  CONTRACTS,
  {
    agent: {
      Run: { SendMessage: sendMessage, GetTask: getTask },
      CancelTask: cancelTask,
    },
  },
  { pollIntervalMilliseconds: 500 },
);

const WORKFLOWS = fileURLToPath(
  new URL('./__fixtures__/workflows.ts', import.meta.url),
);
const RUN_WORKER = fileURLToPath(
  new URL('./__fixtures__/run-worker.ts', import.meta.url),
);

let environment: TestWorkflowEnvironment;
let workflowBundle: { code: string };

beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      executable: {
        type: 'existing-path',
        path: execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim(),
      },
    },
  });
  workflowBundle = await bundleWorkflowCode({ workflowsPath: WORKFLOWS });
});

afterAll(async () => {
  await environment?.teardown();
});

beforeEach(() => {
  starts.length = 0;
  completedFromStart = Number.POSITIVE_INFINITY;
  sendMessage.mockClear();
  getTask.mockClear();
  cancelTask.mockClear();
});

function worker(taskQueue: string): Promise<Worker> {
  return TemporalWorker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowBundle,
    activities: ACTIVITIES,
    shutdownGraceTime: '1s',
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('a worker shut down mid-activity', () => {
  it('leaves the task running, and the next worker attaches to it', async () => {
    const taskQueue = `temporal-worker-${randomUUIDv7()}`;
    const first = await worker(taskQueue);
    const firstRunning = first.run();
    const handle = await environment.client.workflow.start('callAgent', {
      taskQueue,
      workflowId: randomUUIDv7(),
      args: ['text'],
    });
    await until(() => starts.length === 1, 'the first start');
    completedFromStart = 2;
    first.shutdown();
    await firstRunning;

    const second = await worker(taskQueue);
    await expect(second.runUntil(handle.result())).resolves.toBe('answered');
    expect(cancelTask).not.toHaveBeenCalled();
    expect(starts).toHaveLength(2);
    expect(starts[1]?.idempotencyKey).toBe(starts[0]?.idempotencyKey);
    expect(starts[1]).toEqual(starts[0]);
  });
});

describe("a workflow's cancel", () => {
  it('cancels the task', async () => {
    const taskQueue = `temporal-worker-${randomUUIDv7()}`;
    const running = await worker(taskQueue);
    const workflowId = randomUUIDv7();
    await running.runUntil(async () => {
      const handle = await environment.client.workflow.start('callAgent', {
        taskQueue,
        workflowId,
        args: ['text'],
      });
      await until(() => starts.length === 1, 'the start');
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      await until(() => cancelTask.mock.calls.length > 0, 'the task cancel');
    });
    expect(cancelTask).toHaveBeenCalledExactlyOnceWith('task', {
      runtimeSessionId: workflowId,
    });
  });
});

describe('runWorker', () => {
  let child: ChildProcess | undefined;
  afterAll(() => {
    child?.kill('SIGKILL');
  });

  it('exits on SIGTERM inside its grace, an activity in flight', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agentforge-worker-'));
    const bundlePath = join(directory, 'workflows.js');
    writeFileSync(bundlePath, workflowBundle.code);
    const taskQueue = `temporal-worker-${randomUUIDv7()}`;
    const { TEMPORAL_API_KEY: _key, ...inherited } = process.env;
    child = spawn(process.execPath, [RUN_WORKER], {
      env: {
        ...inherited,
        TEMPORAL_ADDRESS: environment.address,
        TEMPORAL_NAMESPACE: 'default',
        WORKFLOW_BUNDLE: bundlePath,
        TASK_QUEUE: taskQueue,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const exited = new Promise<number | null>((resolve) =>
      child?.once('exit', (code) => resolve(code)),
    );
    await environment.client.workflow.start('waitOnAnActivity', {
      taskQueue,
      workflowId: randomUUIDv7(),
    });
    await until(() => output.includes('activity started'), 'the activity');

    const signalledAt = Date.now();
    child.kill('SIGTERM');
    const code = await exited;
    const seconds = (Date.now() - signalledAt) / 1_000;

    expect(code, output).toBe(0);
    expect(output).toContain('worker exited');
    // A 3 s grace, then the activity's cancel and the worker's shutdown.
    expect(seconds).toBeGreaterThanOrEqual(3);
    expect(seconds).toBeLessThan(10);
  });
});
