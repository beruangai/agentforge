/**
 * The whole path on the strands framework, on AgentCore: a caller, through
 * the project client resolved from the deployment's runtime configuration,
 * to hello-agent as strands-smoke-infra's `deploy` left it — the runtime,
 * the harness, Strands Agents and a real model on the Anthropic API — as the
 * test role. A retry attaches; a session resumes in another container from
 * the session bucket; a note in an S3 filesystem is read back in another
 * container; and a run is cancelled mid-shell.
 */
import { randomUUIDv7 } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { awaitTask } from '@beruangai/agentforge/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Client as StrandsSmokeClient,
  client as strandsSmokeClient,
} from '../../client.ts';

const OUTPUTS_FILE = new URL(
  '../../../../../dist/packages/examples/strands-smoke-infra/deploy/outputs.json',
  import.meta.url,
);
const STACK_NAME = 'agentforge-example-strands-smoke-Application';
const OutputsSchema = z.object({
  [STACK_NAME]: z.object({
    RuntimeConfigApplicationId: z.string(),
    HelloAgentImage: z.string(),
    SessionBucketName: z.string(),
  }),
});

/** Another runtime session is another container. AgentCore requires at least 33 characters. */
const newContext = () => ({
  runtimeSessionId: `e2e-${randomUUIDv7()}`,
  idempotencyKey: randomUUIDv7(),
});
const POLL_INTERVAL_MILLISECONDS = 2_000;

let helloAgent: StrandsSmokeClient['helloAgent'];
let outputs: z.infer<typeof OutputsSchema>[typeof STACK_NAME];

beforeAll(async () => {
  outputs = OutputsSchema.parse(
    JSON.parse(await readFile(OUTPUTS_FILE, 'utf8')),
  )[STACK_NAME];
  helloAgent = (
    await strandsSmokeClient.fromRuntimeConfig({
      applicationId: outputs.RuntimeConfigApplicationId,
    })
  ).helloAgent;
});

describe('hello-agent on strands, on AgentCore', () => {
  it('runs a procedure to its validated, typed output, and attaches a retry to it', async () => {
    const context = newContext();
    const started = await helloAgent.Summarise.SendMessage(
      {
        text: 'AgentForge runs an agent procedure as an asynchronous task and returns a typed outcome.',
      },
      context,
    );
    const ended = await awaitTask(helloAgent.Summarise, started, {
      ...context,
      pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS,
    });
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
    }
    expect(ended.output.words).toBe(
      ended.output.summary.split(/\s+/).filter(Boolean).length,
    );
    expect(ended.image).toBe(outputs.HelloAgentImage);
    expect(ended.runs[0]).toMatchObject({ framework: { name: 'strands' } });

    const retry = await helloAgent.Summarise.SendMessage(
      { text: 'ignored: the key names the completed task' },
      context,
    );
    expect(retry).toMatchObject({
      taskId: started.taskId,
      state: 'TASK_STATE_COMPLETED',
      output: ended.output,
    });
  });

  it('resumes a session in another container, from the session bucket', async () => {
    const first = newContext();
    const ended = await awaitTask(
      helloAgent.Summarise,
      await helloAgent.Summarise.SendMessage(
        {
          text: 'AgentForge keeps each strands session in S3, so a session outlives its container.',
        },
        first,
      ),
      { ...first, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
    }
    const { sessionId } = ended.output;
    const listed = await new S3Client({}).send(
      new ListObjectsV2Command({
        Bucket: outputs.SessionBucketName,
        Prefix: `hello-agent/session/${sessionId}/`,
      }),
    );
    expect(listed.Contents?.length ?? 0).toBeGreaterThan(0);

    // The resume can only come from the bucket: an unknown session would
    // fail the run.
    const second = newContext();
    const resumed = await awaitTask(
      helloAgent.Summarise,
      await helloAgent.Summarise.SendMessage(
        {
          text: 'Now summarise the same text again, more briefly.',
          resumeSessionId: sessionId,
        },
        second,
      ),
      { ...second, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (resumed.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(resumed)}`);
    }
    expect(resumed.output.sessionId).toBe(sessionId);
  });

  it('keeps a note in an S3 filesystem, and reads it back in another container', async () => {
    const topic = `e2e-${randomUUIDv7()}`;
    const note = `The notebook outlives the container that wrote ${topic}.`;
    const first = newContext();
    const kept = await awaitTask(
      helloAgent.KeepNote,
      await helloAgent.KeepNote.SendMessage({ topic, note }, first),
      { ...first, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (kept.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(kept)}`);
    }
    expect(kept.output.kept).toBe(true);

    const second = newContext();
    const recalled = await awaitTask(
      helloAgent.RecallNote,
      await helloAgent.RecallNote.SendMessage({ topic }, second),
      { ...second, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (recalled.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(recalled)}`);
    }
    expect(recalled.output.note.trim()).toBe(note);
  });

  it('cancels a run mid-shell', async () => {
    const context = newContext();
    const started = await helloAgent.SleepThenAnswer.SendMessage(
      { seconds: 120 },
      context,
    );
    // Long enough for the model to have started its shell command.
    await delay(20_000);
    const cancelled = await helloAgent.CancelTask(started.taskId, context);
    expect(cancelled.state).toBe('TASK_STATE_CANCELED');
  });
});
