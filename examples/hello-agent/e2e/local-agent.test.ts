/**
 * The whole path, locally: a caller, through AgentForge's client, to this
 * agent's image in Docker — server, task process, harness, the Agent SDK and
 * a real model — and back as a typed outcome.
 */
import { randomUUIDv7 } from 'node:crypto';
import {
  awaitTask,
  createClient,
  localTransport,
} from '@beruangai/agentforge/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { helloAgent } from '../src/contract.ts';
import {
  type LocalAgent,
  startLocalAgent,
} from './__fixtures__/local-agent.ts';

let agent: LocalAgent;
let client: ReturnType<typeof createClient<typeof helloAgent>>;
const runtimeSessionId = `e2e-${randomUUIDv7()}`;
const poll = { runtimeSessionId, pollIntervalMilliseconds: 1_000 };

beforeAll(async () => {
  agent = await startLocalAgent();
  client = createClient(helloAgent, localTransport(agent.url));
});

afterAll(() => {
  if (agent === undefined) return;
  if (process.env.AGENTFORGE_E2E_LOGS) console.log(agent.logs());
  agent.stop();
});

describe('hello-agent, locally', () => {
  let firstSessionId: string;

  it('runs a procedure to its validated, typed output, and records the run', async () => {
    const context = { runtimeSessionId, idempotencyKey: randomUUIDv7() };
    const started = await client.summarise.SendMessage(
      {
        text: 'AgentForge runs a Claude agent procedure as an asynchronous task and returns a typed outcome.',
      },
      context,
    );
    const again = await client.summarise.SendMessage(
      { text: 'ignored: the key names the running task' },
      context,
    );
    expect(again.taskId).toBe(started.taskId);

    const ended = await awaitTask(client.summarise, started, poll);
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${agent.logs()}`,
      );
    }
    expect(ended.output.summary.length).toBeGreaterThan(0);
    expect(ended.output.words).toBe(
      ended.output.summary.split(/\s+/).filter(Boolean).length,
    );
    firstSessionId = ended.output.sessionId;
    const [run] = ended.runs;
    expect(run?.sessionId).toBe(firstSessionId);
    expect(run?.totalCostUsd).toBeGreaterThan(0);
    expect(JSON.stringify(run?.prompt)).toContain(
      'Summarise the following text',
    );
  });

  it('resumes the session it started', async () => {
    const started = await client.summarise.SendMessage(
      {
        text: 'Now summarise the same text again, more briefly.',
        resumeSessionId: firstSessionId,
      },
      { runtimeSessionId, idempotencyKey: randomUUIDv7() },
    );
    const ended = await awaitTask(client.summarise, started, poll);
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${agent.logs()}`,
      );
    }
    expect(ended.output.sessionId).toBe(firstSessionId);
  });

  it('cancels a run mid-turn, and the container is idle again', async () => {
    const context = { runtimeSessionId, idempotencyKey: randomUUIDv7() };
    const started = await client.sleepThenAnswer.SendMessage(
      { seconds: 120 },
      context,
    );
    // Long enough for the model to have started its shell command.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const cancelled = await client.CancelTask(started.taskId, context);
    if (cancelled.state !== 'TASK_STATE_CANCELED') {
      throw new Error(
        `expected cancellation, got ${JSON.stringify(cancelled)}`,
      );
    }
    const ping = await fetch(new URL('/ping', agent.url)).then((response) =>
      response.json(),
    );
    expect(ping).toEqual({ status: 'Healthy' });
  });
});
