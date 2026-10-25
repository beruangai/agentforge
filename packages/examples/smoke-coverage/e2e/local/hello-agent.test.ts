/**
 * The whole path, locally: a caller, through the project client, to
 * hello-agent's container as `serve-hello-agent` runs it — server, task
 * process, harness, the Agent SDK and a real model — and back as a typed
 * outcome, recording the image that ran it and where its transcript is,
 * read back through the client; an attach; a session resumed
 * from its transcript in the local store; a note in an S3 filesystem and a
 * memory, each read back by a task of another runtime session, so from the
 * store and not a kept copy; a journal entry in a git filesystem, pushed by
 * the agent's own tool under a subject the filesystem shapes; a cancel mid-Bash; a procedure that distills
 * its documents in a run before answering in another; and Python importing
 * what the base layer installed.
 */
import { execFileSync } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { readTranscript } from '@beruangai/agentforge/claude/client';
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
import {
  logs,
  removeLocalTranscripts,
  servedUrl,
  untilServing,
} from './__fixtures__/served-agent.ts';

/** The id `image-hello-agent` wrote, which `serve-hello-agent` runs by. */
const IMAGE_ID_FILE = new URL(
  '../../../../../dist/packages/examples/smoke-coverage/image/agents/hello-agent.id',
  import.meta.url,
);

/** The local store's S3, as the host reaches it, and the project's session bucket in it. */
const LOCAL_STORE = new S3Client({
  endpoint: 'http://127.0.0.1:8333',
  forcePathStyle: true,
  region: 'us-east-2',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const SESSION_BUCKET = 'beruangai-smoke-coverage-sessions';
/** The journal's host repository, as `.env.serve` declares it and serve creates it. */
const JOURNAL = new URL(
  '../../../../../.agentforge/repositories/smoke-coverage-journal.git',
  import.meta.url,
).pathname;

function journal(...args: string[]): string {
  return execFileSync('git', ['-C', JOURNAL, ...args], {
    encoding: 'utf8',
  }).trim();
}

let helloAgent: SmokeCoverageClient['helloAgent'];
const RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;
const POLL_OPTIONS = {
  runtimeSessionId: RUNTIME_SESSION_ID,
  pollIntervalMilliseconds: 1_000,
};
/** Another runtime session, whose tasks never see this one's kept copies. */
const OTHER_RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;
const OTHER_POLL_OPTIONS = {
  runtimeSessionId: OTHER_RUNTIME_SESSION_ID,
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
    expect(ended.image).toBe((await readFile(IMAGE_ID_FILE, 'utf8')).trim());
    expect(ended.output.words).toBe(
      ended.output.summary.split(/\s+/).filter(Boolean).length,
    );
    expect(ended.output.userScopePluginStarted).toBe(true);
    firstSessionId = ended.output.sessionId;
    const [run] = ended.runs;
    expect(run?.sessionId).toBe(firstSessionId);
    expect(run?.totalCostUsd).toBeGreaterThan(0);
    // The record says where the transcript is, and the store gives it back.
    expect(run?.transcript).toMatchObject({
      bucket: SESSION_BUCKET,
      agent: 'hello-agent',
    });
    if (run === undefined) throw new Error('the task records no run');
    const transcript = await readTranscript(run, { client: LOCAL_STORE });
    expect(transcript.some((message) => message.type === 'assistant')).toBe(
      true,
    );
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

  it("resumes the session it started from its transcript in the local store, with the image's user scope", async () => {
    const listed = await LOCAL_STORE.send(
      new ListObjectsV2Command({
        Bucket: SESSION_BUCKET,
        Prefix: 'hello-agent/',
      }),
    );
    expect(
      (listed.Contents ?? []).some(({ Key }) =>
        Key?.includes(`/${firstSessionId}/part-`),
      ),
    ).toBe(true);
    removeLocalTranscripts();
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
    // Resumed from the store, in a config directory of the SDK's: the
    // plugin the base image installed at user scope still started.
    expect(ended.output.userScopePluginStarted).toBe(true);
  });

  it('keeps a note in an S3 filesystem, and a task of another session reads it back from the store', async () => {
    const topic = `e2e-${randomUUIDv7()}`;
    const note = `The notebook outlives the task that wrote ${topic}.`;
    const kept = await awaitTask(
      helloAgent.KeepNote,
      await helloAgent.KeepNote.SendMessage(
        { topic, note },
        {
          runtimeSessionId: RUNTIME_SESSION_ID,
          idempotencyKey: randomUUIDv7(),
        },
      ),
      POLL_OPTIONS,
    );
    if (kept.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(kept)}\n${logs()}`,
      );
    }
    expect(kept.output.kept).toBe(true);
    const recalled = await awaitTask(
      helloAgent.RecallNote,
      await helloAgent.RecallNote.SendMessage(
        { topic },
        {
          runtimeSessionId: OTHER_RUNTIME_SESSION_ID,
          idempotencyKey: randomUUIDv7(),
        },
      ),
      OTHER_POLL_OPTIONS,
    );
    if (recalled.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(recalled)}\n${logs()}`,
      );
    }
    expect(recalled.output.note.trim()).toBe(note);
  });

  it('remembers a fact, and a task of another session recalls it from its memory space in the store', async () => {
    const space = `e2e-${randomUUIDv7()}`;
    const codename = `HERON-${randomUUIDv7().slice(-8).toUpperCase()}`;
    const remembered = await awaitTask(
      helloAgent.Remember,
      await helloAgent.Remember.SendMessage(
        {
          space,
          fact: `The deploy codename for this project is ${codename}, chosen because the release team names deploys after birds.`,
        },
        {
          runtimeSessionId: RUNTIME_SESSION_ID,
          idempotencyKey: randomUUIDv7(),
        },
      ),
      POLL_OPTIONS,
    );
    if (remembered.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(remembered)}\n${logs()}`,
      );
    }
    expect(remembered.output.saved).toBe(true);
    const recalled = await awaitTask(
      helloAgent.Recall,
      await helloAgent.Recall.SendMessage(
        { space, question: 'What is the deploy codename for this project?' },
        {
          runtimeSessionId: OTHER_RUNTIME_SESSION_ID,
          idempotencyKey: randomUUIDv7(),
        },
      ),
      OTHER_POLL_OPTIONS,
    );
    if (recalled.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(recalled)}\n${logs()}`,
      );
    }
    expect(recalled.output.answer).toContain(codename);
  });

  it("keeps a journal entry in a git filesystem, pushed by the agent's tool with its message shaped by the filesystem, and the session's next task finds what the first kept locally", async () => {
    const topic = `e2e-${randomUUIDv7()}`;
    const keep = async (day: string, scratch: string) => {
      const idempotencyKey = randomUUIDv7();
      const message = `keep the ${day} entry`;
      const kept = await awaitTask(
        helloAgent.KeepJournal,
        await helloAgent.KeepJournal.SendMessage(
          {
            topic,
            day,
            entry: `On ${day}, ${topic} was kept in git.`,
            message,
            scratch,
          },
          { runtimeSessionId: RUNTIME_SESSION_ID, idempotencyKey },
        ),
        POLL_OPTIONS,
      );
      if (kept.state !== 'TASK_STATE_COMPLETED') {
        throw new Error(
          `expected completion, got ${JSON.stringify(kept)}\n${logs()}`,
        );
      }
      expect(kept.output.written).toBe(true);
      // The agent's push: its message, shaped by the filesystem's
      // commitMessage, and the trailers naming the task.
      const commit = journal(
        'log',
        '-1',
        '--format=%B',
        'main',
        '--',
        `topics/${topic}/entries/${day}.md`,
      );
      expect(commit.startsWith(`journal(${topic}): `)).toBe(true);
      expect(commit).toContain(message);
      expect(commit).toContain(`AgentForge-Idempotency-Key: ${idempotencyKey}`);
      expect(journal('show', `main:topics/${topic}/entries/${day}.md`)).toBe(
        `On ${day}, ${topic} was kept in git.`,
      );
      // The handler's closing push recorded nothing new, and names the commit the entry stands at.
      expect(kept.output.commit).toBe(
        journal(
          'log',
          '-1',
          '--format=%H',
          'main',
          '--',
          `topics/${topic}/entries/${day}.md`,
        ),
      );
      return kept.output;
    };
    expect((await keep('monday', 'first scratch')).carried).toBeUndefined();
    expect((await keep('tuesday', 'second scratch')).carried).toBe(
      'first scratch',
    );
    // Outside the write scope: never committed.
    expect(() => journal('show', `main:topics/${topic}/scratch.md`)).toThrow();
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

  it('runs Python importing NautilusTrader, which its base layer installed from a glibc-only wheel', async () => {
    const started = await helloAgent.ReportNautilusTraderVersion.SendMessage(
      {},
      { runtimeSessionId: RUNTIME_SESSION_ID, idempotencyKey: randomUUIDv7() },
    );
    const ended = await awaitTask(
      helloAgent.ReportNautilusTraderVersion,
      started,
      POLL_OPTIONS,
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.version).toBe('1.231.0');
  });
});
