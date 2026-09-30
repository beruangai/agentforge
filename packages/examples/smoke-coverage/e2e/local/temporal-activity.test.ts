/**
 * The Temporal caller: AgentForge's activity over the project client, against
 * hello-agent's container, in Temporal's activity environment — heartbeats,
 * cancellation and failure mapping, without a worker.
 */
import { randomUUIDv7 } from 'node:crypto';
import { procedureActivity } from '@beruangai/agentforge/temporal';
import { CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { type SmokeCoverageClient, smokeCoverageClient } from '../../client.ts';
import { untilServing } from './__fixtures__/served-agent.ts';

let helloAgent: SmokeCoverageClient['helloAgent'];
const RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;

beforeAll(async () => {
  await untilServing();
  helloAgent = smokeCoverageClient.local().helloAgent;
});

function environment() {
  return new MockActivityEnvironment({
    activityId: '1',
    workflowExecution: {
      workflowId: `e2e-${randomUUIDv7()}`,
      runId: randomUUIDv7(),
    },
  });
}

describe('the Temporal activity, locally', () => {
  it('returns the typed output, heartbeating the task as it runs', async () => {
    const activity = procedureActivity(helloAgent.Summarise, {
      runtimeSessionId: () => RUNTIME_SESSION_ID,
      cancelTask: helloAgent.CancelTask,
      pollIntervalMilliseconds: 1_000,
    });
    const env = environment();
    const heartbeats: unknown[] = [];
    env.on('heartbeat', (details) => heartbeats.push(details));
    // Temporal's `run` does not infer an activity's result.
    const output: Awaited<ReturnType<typeof activity>> = await env.run(
      activity,
      {
        text: 'Temporal retries an activity; AgentForge attaches the retry to the same task.',
      },
    );
    expect(output.words).toBe(
      output.summary.split(/\s+/).filter(Boolean).length,
    );
    expect(heartbeats.length).toBeGreaterThan(0);
  });

  it('cancels its task when the activity is cancelled', async () => {
    const activity = procedureActivity(helloAgent.SleepThenAnswer, {
      runtimeSessionId: () => RUNTIME_SESSION_ID,
      cancelTask: helloAgent.CancelTask,
      pollIntervalMilliseconds: 1_000,
    });
    const env = environment();
    let taskId: string | undefined;
    env.on('heartbeat', (details: { taskId: string }) => {
      taskId = details.taskId;
    });
    const running = env.run(activity, { seconds: 120 });
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    env.cancel();
    await expect(running).rejects.toBeInstanceOf(CancelledFailure);
    if (taskId === undefined) {
      throw new Error('the activity never heartbeat its task');
    }
    const task = await helloAgent.SleepThenAnswer.GetTask(taskId, {
      runtimeSessionId: RUNTIME_SESSION_ID,
    });
    expect(task.state).toBe('TASK_STATE_CANCELED');
  });
});
