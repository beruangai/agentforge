/**
 * The whole path on the strands framework, locally: a caller, through the
 * project client, to hello-agent's container as `serve-hello-agent` runs it —
 * server, task process, harness, Strands Agents and a real model on the
 * Anthropic API — and back as a typed outcome, recording the run and where
 * its session is, read back through `readSession`; the layers' `AGENTS.md`
 * composed base first into the system prompt; a session resumed from the
 * local store, the only place a strands session is kept; a note in an S3
 * filesystem, written through the file tool and read back by a later task;
 * and a cancel mid-shell.
 */
import { randomUUIDv7 } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { awaitTask } from '@beruangai/agentforge/client';
import { readSession } from '@beruangai/agentforge/strands/client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Client as StrandsSmokeClient,
  client as strandsSmokeClient,
} from '../../client.ts';
import { logs, servedUrl, untilServing } from './__fixtures__/served-agent.ts';

/** The id `image-hello-agent` wrote, which `serve-hello-agent` runs by. */
const IMAGE_ID_FILE = new URL(
  '../../../../../dist/packages/examples/strands-smoke/image/agents/hello-agent.id',
  import.meta.url,
);

/** The local store's S3, as the host reaches it, and the project's session bucket in it. */
const LOCAL_STORE = new S3Client({
  endpoint: 'http://127.0.0.1:8333',
  forcePathStyle: true,
  region: 'us-east-2',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const SESSION_BUCKET = 'beruangai-strands-smoke-sessions';

let helloAgent: StrandsSmokeClient['helloAgent'];
const RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;
const POLL_OPTIONS = {
  runtimeSessionId: RUNTIME_SESSION_ID,
  pollIntervalMilliseconds: 1_000,
};
const newContext = () => ({
  runtimeSessionId: RUNTIME_SESSION_ID,
  idempotencyKey: randomUUIDv7(),
});

beforeAll(async () => {
  await untilServing();
  helloAgent = strandsSmokeClient.local().helloAgent;
});

describe('hello-agent on strands, locally', () => {
  let firstSessionId: string;

  it('runs a procedure to its validated, typed output, attaches a retry, and records the run', async () => {
    const context = newContext();
    const started = await helloAgent.Summarise.SendMessage(
      {
        text: 'AgentForge runs an agent procedure as an asynchronous task and returns a typed outcome.',
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
    expect(ended.image).toBe((await readFile(IMAGE_ID_FILE, 'utf8')).trim());
    expect(ended.output.words).toBe(
      ended.output.summary.split(/\s+/).filter(Boolean).length,
    );
    firstSessionId = ended.output.sessionId;
    const [run] = ended.runs;
    if (run === undefined) throw new Error('the task records no run');
    expect(run).toMatchObject({
      framework: { name: 'strands' },
      sessionId: firstSessionId,
      transcript: { bucket: SESSION_BUCKET, agent: 'hello-agent' },
    });
    expect(run.usage?.outputTokens).toBeGreaterThan(0);
    const session = await readSession(run, { client: LOCAL_STORE });
    expect(session.some((message) => message.role === 'assistant')).toBe(true);

    // The container log has the prompt whole, and the system prompt composed
    // from the layers, base first, before AgentForge's fragments.
    const logged = logs()
      .split('\n')
      .filter((line) => line.includes('"agentforge.prompt"'))
      .map(
        (line) =>
          JSON.parse(line.slice(line.indexOf('{'))) as {
            promptHash: string;
            systemPrompt: { text: string }[];
          },
      )
      .find((entry) => entry.promptHash === run.promptHash);
    const system = (logged?.systemPrompt ?? []).map(({ text }) => text);
    const base = system.findIndex((text) =>
      text.includes('You are an agent in strands-smoke'),
    );
    const agent = system.findIndex((text) =>
      text.includes('You are hello-agent.'),
    );
    const fragment = system.findIndex((text) =>
      text.includes('strands_structured_output'),
    );
    expect(base).toBeGreaterThanOrEqual(0);
    expect(agent).toBeGreaterThan(base);
    expect(fragment).toBeGreaterThan(agent);
  });

  it('resumes the session it started, from the local store', async () => {
    const listed = await LOCAL_STORE.send(
      new ListObjectsV2Command({
        Bucket: SESSION_BUCKET,
        Prefix: `hello-agent/session/${firstSessionId}/`,
      }),
    );
    expect(listed.Contents?.length ?? 0).toBeGreaterThan(0);
    const ended = await awaitTask(
      helloAgent.Summarise,
      await helloAgent.Summarise.SendMessage(
        {
          text: 'Now summarise the same text again, more briefly.',
          resumeSessionId: firstSessionId,
        },
        newContext(),
      ),
      POLL_OPTIONS,
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.sessionId).toBe(firstSessionId);
    const [run] = ended.runs;
    if (run === undefined) throw new Error('the task records no run');
    const session = await readSession(run, { client: LOCAL_STORE });
    expect(
      session.filter((message) => message.role === 'user').length,
    ).toBeGreaterThan(1);
  });

  it('keeps a note in an S3 filesystem through the file tool, and a later task reads it back from the store', async () => {
    const topic = `e2e-${randomUUIDv7()}`;
    const note = `The notebook outlives the task that wrote ${topic}.`;
    const kept = await awaitTask(
      helloAgent.KeepNote,
      await helloAgent.KeepNote.SendMessage({ topic, note }, newContext()),
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
      await helloAgent.RecallNote.SendMessage({ topic }, newContext()),
      POLL_OPTIONS,
    );
    if (recalled.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(recalled)}\n${logs()}`,
      );
    }
    expect(recalled.output.note.trim()).toBe(note);
  });

  it('cancels a run mid-shell, and the container is idle again', async () => {
    const context = newContext();
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
});
