/**
 * The whole path, on AgentCore: a caller, through the project client resolved
 * from the deployment's runtime configuration, to hello-agent as
 * smoke-coverage-infra's `deploy` left it — the runtime, the harness, the
 * Agent SDK and a real model — as the test role. A retry attaches; a session
 * outlives its container, resuming in another from its transcript in S3; so
 * do an S3 filesystem's files; a task whose container the platform stops
 * ends `LOST`, its retry running as the next attempt; two tasks in one
 * container never share a mount's local directory; a memory saved in one
 * container is recalled in another; and a procedure's runs
 * — a distillation, then the answer — are each recorded on its task.
 */
import { randomUUIDv7 } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  BedrockAgentCoreClient,
  StopRuntimeSessionCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { awaitTask } from '@beruangai/agentforge/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
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

const OUTPUTS_FILE = new URL(
  '../../../../../dist/packages/examples/smoke-coverage-infra/deploy/outputs.json',
  import.meta.url,
);
const STACK_NAME = 'agentforge-example-smoke-coverage-Application';
const OutputsSchema = z.object({
  [STACK_NAME]: z.object({
    RuntimeConfigApplicationId: z.string(),
    HelloAgentRuntimeArn: z.string(),
    HelloAgentSessionBucketName: z.string(),
  }),
});

/** AgentCore requires at least 33 characters. */
const newRuntimeSessionId = (): string => `e2e-${randomUUIDv7()}`;
const POLL_INTERVAL_MILLISECONDS = 2_000;

let helloAgent: SmokeCoverageClient['helloAgent'];
let outputs: z.infer<typeof OutputsSchema>[typeof STACK_NAME];
let agentCore: BedrockAgentCoreClient;

beforeAll(async () => {
  outputs = OutputsSchema.parse(
    JSON.parse(await readFile(OUTPUTS_FILE, 'utf8')),
  )[STACK_NAME];
  helloAgent = (
    await smokeCoverageClient.fromRuntimeConfig({
      applicationId: outputs.RuntimeConfigApplicationId,
    })
  ).helloAgent;
  agentCore = new BedrockAgentCoreClient({});
});

/** Ends the runtime session: its container stops, and the next call lands on a fresh one. */
async function stopContainer(runtimeSessionId: string): Promise<void> {
  await agentCore.send(
    new StopRuntimeSessionCommand({
      agentRuntimeArn: outputs.HelloAgentRuntimeArn,
      runtimeSessionId,
    }),
  );
}

describe('hello-agent, on AgentCore', () => {
  it('runs a procedure to its validated, typed output, and attaches a retry to it', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const started = await helloAgent.Summarise.SendMessage(
      {
        text: 'AgentForge runs a Claude agent procedure as an asynchronous task and returns a typed outcome.',
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
    expect(ended.runs[0]?.totalCostUsd).toBeGreaterThan(0);

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

  it('resumes a session in another container, from its transcript in S3', async () => {
    const first = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const ended = await awaitTask(
      helloAgent.Summarise,
      await helloAgent.Summarise.SendMessage(
        {
          text: 'AgentForge persists each session transcript in S3, so a session outlives its container.',
        },
        first,
      ),
      { ...first, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
    }
    const { sessionId } = ended.output;
    await stopContainer(first.runtimeSessionId);

    // The container is gone; the transcript is not.
    const listed = await new S3Client({}).send(
      new ListObjectsV2Command({ Bucket: outputs.HelloAgentSessionBucketName }),
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
    const first = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const kept = await awaitTask(
      helloAgent.KeepNote,
      await helloAgent.KeepNote.SendMessage({ topic, note }, first),
      { ...first, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
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
      helloAgent.RecallNote,
      await helloAgent.RecallNote.SendMessage({ topic }, second),
      { ...second, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (recalled.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(recalled)}`);
    }
    expect(recalled.output.note.trim()).toBe(note);
  });

  it('remembers a fact in one container, and recalls it in another from its memory space', async () => {
    const space = `e2e-${randomUUIDv7()}`;
    const codename = `HERON-${randomUUIDv7().slice(-8).toUpperCase()}`;
    const first = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const remembered = await awaitTask(
      helloAgent.Remember,
      await helloAgent.Remember.SendMessage(
        {
          space,
          fact: `The deploy codename for this project is ${codename}, chosen because the release team names deploys after birds.`,
        },
        first,
      ),
      { ...first, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (remembered.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(remembered)}`);
    }
    expect(remembered.output.saved).toBe(true);
    await stopContainer(first.runtimeSessionId);

    // Another runtime session is another container: the memory can only
    // come from the bucket.
    const second = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const recalled = await awaitTask(
      helloAgent.Recall,
      await helloAgent.Recall.SendMessage(
        { space, question: 'What is the deploy codename for this project?' },
        second,
      ),
      { ...second, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (recalled.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(recalled)}`);
    }
    expect(recalled.output.answer).toContain(codename);
  });

  describe('two notes kept at once in one container', () => {
    /** Starts KeepNote on each topic together, in one runtime session, and waits for both. */
    async function keepTogether(topics: readonly [string, string]) {
      const runtimeSessionId = newRuntimeSessionId();
      return Promise.all(
        topics.map(async (topic, index) => {
          const context = { runtimeSessionId, idempotencyKey: randomUUIDv7() };
          const note = `Note ${index} kept on ${topic}.`;
          const ended = await awaitTask(
            helloAgent.KeepNote,
            await helloAgent.KeepNote.SendMessage({ topic, note }, context),
            {
              ...context,
              pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS,
            },
          );
          return { topic, note, ended };
        }),
      );
    }

    async function recall(topic: string): Promise<string> {
      const context = {
        runtimeSessionId: newRuntimeSessionId(),
        idempotencyKey: randomUUIDv7(),
      };
      const recalled = await awaitTask(
        helloAgent.RecallNote,
        await helloAgent.RecallNote.SendMessage({ topic }, context),
        { ...context, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
      );
      if (recalled.state !== 'TASK_STATE_COMPLETED') {
        throw new Error(`expected completion, got ${JSON.stringify(recalled)}`);
      }
      return recalled.output.note.trim();
    }

    it('keeps each on its own topic, in its own directory', async () => {
      const kept = await keepTogether([
        `e2e-${randomUUIDv7()}`,
        `e2e-${randomUUIDv7()}`,
      ]);
      for (const { ended } of kept) {
        expect(ended).toMatchObject({
          state: 'TASK_STATE_COMPLETED',
          output: { kept: true },
        });
      }
      for (const { topic, note } of kept) {
        expect(await recall(topic)).toBe(note);
      }
    });

    it('refuses the second on one topic while the first holds its directory, retryably', async () => {
      const topic = `e2e-${randomUUIDv7()}`;
      const kept = await keepTogether([topic, topic]);
      const completed = kept.filter(
        ({ ended }) => ended.state === 'TASK_STATE_COMPLETED',
      );
      const refused = kept.filter(
        ({ ended }) => ended.state === 'TASK_STATE_FAILED',
      );
      expect(completed).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(refused[0]?.ended).toMatchObject({
        cause: {
          code: 'FILESYSTEM_UNSYNCED',
          retryable: true,
          message: expect.stringMatching(
            /mounted by task .+ in this container/,
          ),
        },
      });
      expect(await recall(topic)).toBe(completed[0]?.note);
    });
  });

  it('ends a task LOST when the platform stops its container mid-Bash, and runs the retry as the next attempt', async () => {
    const context = {
      runtimeSessionId: newRuntimeSessionId(),
      idempotencyKey: randomUUIDv7(),
    };
    const started = await helloAgent.SleepThenAnswer.SendMessage(
      { seconds: 120 },
      context,
    );
    // Long enough for the model to have started its shell command.
    await delay(20_000);
    const running = await helloAgent.SleepThenAnswer.GetTask(
      started.taskId,
      context,
    );
    expect(running.state).toBe('TASK_STATE_WORKING');
    await stopContainer(context.runtimeSessionId);
    // The next call lands on a fresh container, which reads the task from the store.
    const ended = await awaitTask(helloAgent.SleepThenAnswer, started, {
      ...context,
      pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS,
    });
    expect(ended).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'LOST', retryable: true },
    });

    const retry = await helloAgent.SleepThenAnswer.SendMessage(
      { seconds: 1 },
      context,
    );
    expect(retry.taskId).not.toBe(started.taskId);
    const retried = await awaitTask(helloAgent.SleepThenAnswer, retry, {
      ...context,
      pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS,
    });
    if (retried.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(retried)}`);
    }
    expect(retried.attempt).toBe(2);
    expect(retried.output.answer.length).toBeGreaterThan(0);
  });

  describe('distill, then answer', () => {
    async function distillThenAnswer(
      input: Parameters<typeof helloAgent.DistillThenAnswer.SendMessage>[0],
    ) {
      const context = {
        runtimeSessionId: newRuntimeSessionId(),
        idempotencyKey: randomUUIDv7(),
      };
      const started = await helloAgent.DistillThenAnswer.SendMessage(
        input,
        context,
      );
      const ended = await awaitTask(helloAgent.DistillThenAnswer, started, {
        ...context,
        pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS,
      });
      if (ended.state !== 'TASK_STATE_COMPLETED') {
        throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
      }
      return ended;
    }

    it('distills documents over the cap in a run of their own, then answers from the distillation', async () => {
      const ended = await distillThenAnswer({
        documents: LOGBOOKS,
        question: QUESTION,
        capTokens: SMALL_CAP_TOKENS,
      });
      expect(ended.output.distilled).toBe(true);
      expect(ended.output.answer).toMatch(ANSWER);
      expect(ended.runs).toHaveLength(2);
    });

    it('passes documents within the cap whole, in one run', async () => {
      const ended = await distillThenAnswer({
        documents: NOTE,
        question: QUESTION,
        capTokens: LARGE_CAP_TOKENS,
      });
      expect(ended.output.distilled).toBe(false);
      expect(ended.output.answer).toMatch(ANSWER);
      expect(ended.runs).toHaveLength(1);
    });
  });
});
