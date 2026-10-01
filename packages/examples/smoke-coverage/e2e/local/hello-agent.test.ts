/**
 * The whole path, locally: a caller, through the project client, to
 * hello-agent's container as `serve-hello-agent` runs it — server, task
 * process, harness, the Agent SDK and a real model — and back as a typed
 * outcome; an attach, a resumed session, a cancel mid-Bash, and a procedure
 * that distills its documents in a run before answering in another.
 */
import { randomUUIDv7 } from 'node:crypto';
import { awaitTask } from '@beruangai/agentforge/client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Client as SmokeCoverageClient,
  client as smokeCoverageClient,
} from '../../client.ts';
import {
  ANSWER,
  LARGE_CAP_TOKENS,
  LOGBOOKS,
  NOTE,
  QUESTION,
  SMALL_CAP_TOKENS,
} from '../__fixtures__/documents.ts';
import { logs, servedUrl, untilServing } from './__fixtures__/served-agent.ts';

let helloAgent: SmokeCoverageClient['helloAgent'];
const RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;
const POLL_OPTIONS = {
  runtimeSessionId: RUNTIME_SESSION_ID,
  pollIntervalMilliseconds: 1_000,
};

beforeAll(async () => {
  await untilServing();
  helloAgent = smokeCoverageClient.local().helloAgent;
});

describe('hello-agent, locally', () => {
  let firstSessionId: string;

  it('runs a procedure to its validated, typed output, attaches a retry, and records the run', async () => {
    const context = {
      runtimeSessionId: RUNTIME_SESSION_ID,
      idempotencyKey: randomUUIDv7(),
    };
    const started = await helloAgent.Summarise.SendMessage(
      {
        text: 'AgentForge runs a Claude agent procedure as an asynchronous task and returns a typed outcome.',
      },
      context,
    );
    const again = await helloAgent.Summarise.SendMessage(
      { text: 'ignored: the key names the running task' },
      context,
    );
    expect(again.taskId).toBe(started.taskId);

    const ended = await awaitTask(helloAgent.Summarise, started, POLL_OPTIONS);
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
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
    // The record carries the prompt's hash; the container log, the prompt whole.
    expect(run?.promptBytes).toBeGreaterThan(0);
    const logged = logs()
      .split('\n')
      .filter((line) => line.includes('"agentforge.prompt"'))
      .map((line) => JSON.parse(line.slice(line.indexOf('{'))));
    expect(logged).toContainEqual(
      expect.objectContaining({
        promptHash: run?.promptHash,
        prompt: [
          { type: 'text', text: 'Summarise the text in one sentence.' },
          {
            type: 'text',
            text: expect.stringMatching(/^<text>\n[\s\S]+\n<\/text>$/),
          },
        ],
      }),
    );
  });

  it('resumes the session it started', async () => {
    const started = await helloAgent.Summarise.SendMessage(
      {
        text: 'Now summarise the same text again, more briefly.',
        resumeSessionId: firstSessionId,
      },
      { runtimeSessionId: RUNTIME_SESSION_ID, idempotencyKey: randomUUIDv7() },
    );
    const ended = await awaitTask(helloAgent.Summarise, started, POLL_OPTIONS);
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.sessionId).toBe(firstSessionId);
  });

  it('cancels a run mid-Bash, and the container is idle again', async () => {
    const context = {
      runtimeSessionId: RUNTIME_SESSION_ID,
      idempotencyKey: randomUUIDv7(),
    };
    const started = await helloAgent.SleepThenAnswer.SendMessage(
      { seconds: 120 },
      context,
    );
    // Long enough for the model to have started its shell command.
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const cancelled = await helloAgent.CancelTask(started.taskId, context);
    if (cancelled.state !== 'TASK_STATE_CANCELED') {
      throw new Error(
        `expected cancellation, got ${JSON.stringify(cancelled)}\n${logs()}`,
      );
    }
    const ping = await fetch(new URL('/ping', await servedUrl())).then(
      (response) => response.json(),
    );
    expect(ping).toEqual({ status: 'Healthy' });
  });

  it('distills documents over the cap in a run of their own, then answers from the distillation', async () => {
    const started = await helloAgent.DistillThenAnswer.SendMessage(
      { documents: LOGBOOKS, question: QUESTION, capTokens: SMALL_CAP_TOKENS },
      { runtimeSessionId: RUNTIME_SESSION_ID, idempotencyKey: randomUUIDv7() },
    );
    const ended = await awaitTask(
      helloAgent.DistillThenAnswer,
      started,
      POLL_OPTIONS,
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.distilled).toBe(true);
    expect(ended.output.answer).toMatch(ANSWER);
    expect(ended.runs).toHaveLength(2);
  });

  it('passes documents within the cap whole, in one run', async () => {
    const started = await helloAgent.DistillThenAnswer.SendMessage(
      { documents: NOTE, question: QUESTION, capTokens: LARGE_CAP_TOKENS },
      { runtimeSessionId: RUNTIME_SESSION_ID, idempotencyKey: randomUUIDv7() },
    );
    const ended = await awaitTask(
      helloAgent.DistillThenAnswer,
      started,
      POLL_OPTIONS,
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.distilled).toBe(false);
    expect(ended.output.answer).toMatch(ANSWER);
    expect(ended.runs).toHaveLength(1);
  });
});
