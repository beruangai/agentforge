/**
 * The Temporal caller: AgentForge's activity against this agent's image, in
 * Temporal's activity environment, so heartbeats, cancellation and failure
 * mapping are exercised without a worker.
 */
import { randomUUIDv7 } from 'node:crypto';
import { createClient, localTransport } from '@beruangai/agentforge/client';
import { procedureActivity } from '@beruangai/agentforge/temporal';
import { CancelledFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type LocalAgent,
  startLocalAgent,
} from '../../../__fixtures__/local-agent.ts';
import { helloAgent } from '../../files/contract.ts';

const AGENT_IMAGE = 'agentforge-examples/hello-agent:local';

let agent: LocalAgent;
let client: ReturnType<typeof createClient<typeof helloAgent>>;
const RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;

beforeAll(async () => {
  agent = await startLocalAgent(AGENT_IMAGE);
  client = createClient(helloAgent, localTransport(agent.url));
});

afterAll(() => agent?.stop());

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
    const activity = procedureActivity(client.summarise, {
      runtimeSessionId: () => RUNTIME_SESSION_ID,
      cancelTask: client.CancelTask,
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
    const activity = procedureActivity(client.sleepThenAnswer, {
      runtimeSessionId: () => RUNTIME_SESSION_ID,
      cancelTask: client.CancelTask,
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
    if (taskId === undefined)
      throw new Error('the activity never heartbeat its task');
    const task = await client.sleepThenAnswer.GetTask(taskId, {
      runtimeSessionId: RUNTIME_SESSION_ID,
    });
    expect(task.state).toBe('TASK_STATE_CANCELED');
  });
});
