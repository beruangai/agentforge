/**
 * The whole path, on AgentCore: a caller, through AgentForge's client and
 * `agentCoreTransport`, to this agent as `deploy` left it — the runtime, the
 * harness, the Agent SDK and a real model — and back as a typed outcome; and
 * a task whose container the platform stops ends `LOST`, its retry running as
 * the next attempt; and a session outlives its container, resuming in
 * another from its transcript in S3; and so do a working directory's files.
 */
import { randomUUIDv7 } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import {
  agentCoreTransport,
  awaitTask,
  createClient,
} from '@beruangai/agentforge/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { helloAgent } from '../../files/contract.ts';

/** Where `deploy` writes its stack outputs. */
const DEPLOY_OUTPUTS = new URL(
  '../../../../dist/examples/hello-agent/deploy/outputs.json',
  import.meta.url,
);

function deployOutput(name: string): string {
  const outputs = JSON.parse(readFileSync(DEPLOY_OUTPUTS, 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  const value = outputs['agentforge-example-hello-agent']?.[name];
  if (value === undefined) {
    throw new Error(`no ${name} in ${DEPLOY_OUTPUTS.pathname}`);
  }
  return value;
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set; run through \`nx run @beruangai/example-hello-agent:e2e-agentcore\`, which loads it from .env.integ`,
    );
  }
  return value;
}

/** AgentCore requires at least 33 characters. */
const newRuntimeSessionId = (): string => `e2e-${randomUUIDv7()}`;

let agentRuntimeArn: string;
let region: string;
let client: ReturnType<typeof createClient<typeof helloAgent>>;

beforeAll(() => {
  region = required('AWS_REGION');
  agentRuntimeArn = deployOutput('AgentRuntimeArn');
  client = createClient(
    helloAgent,
    agentCoreTransport({ agentRuntimeArn, region }),
  );
});

describe('hello-agent, on AgentCore', () => {
  it('runs a procedure to its validated, typed output, and attaches a retry to it', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const started = await client.summarise.SendMessage(
      {
        text: 'AgentForge runs a Claude agent procedure as an asynchronous task and returns a typed outcome.',
      },
      context,
    );
    const ended = await awaitTask(client.summarise, started, {
      ...context,
      pollIntervalMilliseconds: 2_000,
    });
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
    }
    expect(ended.output.words).toBe(
      ended.output.summary.split(/\s+/).filter(Boolean).length,
    );
    expect(ended.runs[0]?.totalCostUsd).toBeGreaterThan(0);

    const retry = await client.summarise.SendMessage(
      { text: 'ignored: the key names the completed task' },
      context,
    );
    expect(retry).toMatchObject({
      taskId: started.taskId,
      state: 'TASK_STATE_COMPLETED',
      output: ended.output,
    });
  });

  it('resumes a session in another container, from its transcript in S3', async () => {
    const first = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const started = await client.summarise.SendMessage(
      {
        text: 'AgentForge persists each session transcript in S3, so a session outlives its container.',
      },
      first,
    );
    const ended = await awaitTask(client.summarise, started, {
      ...first,
      pollIntervalMilliseconds: 2_000,
    });
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
    }
    const { sessionId } = ended.output;
    await new BedrockAgentCoreClient({ region }).send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn,
        runtimeSessionId: first.runtimeSessionId,
      }),
    );

    // The container is gone; the transcript is not.
    const listed = await new S3Client({ region }).send(
      new ListObjectsV2Command({ Bucket: deployOutput('SessionBucketName') }),
    );
    expect(
      (listed.Contents ?? []).some(({ Key }) =>
        Key?.includes(`/${sessionId}/part-`),
      ),
    ).toBe(true);

    // Another runtime session is another container: the resume can only
    // come from the store. An unknown session would fail the run.
    const second = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const resumed = await awaitTask(
      client.summarise,
      await client.summarise.SendMessage(
        {
          text: 'Now summarise the same text again, more briefly.',
          resumeSessionId: sessionId,
        },
        second,
      ),
      { ...second, pollIntervalMilliseconds: 2_000 },
    );
    if (resumed.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(resumed)}`);
    }
    expect(resumed.output.sessionId).toBe(sessionId);
  });

  it('keeps a note in a working directory, and reads it back in another container', async () => {
    const topic = `e2e-${randomUUIDv7()}`;
    const note = `The notebook outlives the container that wrote ${topic}.`;
    const first = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const kept = await awaitTask(
      client.keepNote,
      await client.keepNote.SendMessage({ topic, note }, first),
      { ...first, pollIntervalMilliseconds: 2_000 },
    );
    if (kept.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(kept)}`);
    }
    expect(kept.output.kept).toBe(true);

    // Another runtime session is another container: the note can only come
    // from the bucket.
    const second = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const recalled = await awaitTask(
      client.recallNote,
      await client.recallNote.SendMessage({ topic }, second),
      { ...second, pollIntervalMilliseconds: 2_000 },
    );
    if (recalled.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(recalled)}`);
    }
    expect(recalled.output.note.trim()).toBe(note);
  });

  it('ends a task LOST when the platform stops its container mid-Bash, and runs the retry as the next attempt', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const started = await client.sleepThenAnswer.SendMessage(
      { seconds: 120 },
      context,
    );
    // Long enough for the model to have started its shell command.
    await delay(20_000);
    const running = await client.sleepThenAnswer.GetTask(
      started.taskId,
      context,
    );
    expect(running.state).toBe('TASK_STATE_WORKING');
    await new BedrockAgentCoreClient({ region }).send(
      new StopRuntimeSessionCommand({
        agentRuntimeArn,
        runtimeSessionId: context.runtimeSessionId,
      }),
    );
    // The next call lands on a fresh container, which reads the task from the store.
    const ended = await awaitTask(client.sleepThenAnswer, started, {
      ...context,
      pollIntervalMilliseconds: 2_000,
    });
    expect(ended).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'LOST', retryable: true },
    });

    const retry = await client.sleepThenAnswer.SendMessage(
      { seconds: 1 },
      context,
    );
    expect(retry.taskId).not.toBe(started.taskId);
    const retried = await awaitTask(client.sleepThenAnswer, retry, {
      ...context,
      pollIntervalMilliseconds: 2_000,
    });
    if (retried.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(retried)}`);
    }
    expect(retried.attempt).toBe(2);
    expect(retried.output.answer.length).toBeGreaterThan(0);
  });
});
