/**
 * The whole path for a realistic non-coding agent on the strands framework,
 * locally: a caller, through the project client, to the briefer's container
 * as `serve-briefer` runs it, and back as a typed brief. The corpus is read
 * from an S3 filesystem the caller filled, every claim cites a document of
 * it in that document's own words, the answer is held until every document
 * was read, and the terms the corpus defines are kept in a glossary that
 * outlives the task.
 */
import { randomUUIDv7 } from 'node:crypto';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { awaitTask } from '@beruangai/agentforge/client';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type Client as ResearchBriefClient,
  client as researchBriefClient,
} from '../../client.ts';
import {
  corpusDocuments,
  QUESTION,
  uploadCorpus,
} from '../__fixtures__/corpus.ts';
import { logs, untilServing } from './__fixtures__/served-agent.ts';

/** The local store's S3, as the host reaches it. */
const LOCAL_STORE = new S3Client({
  endpoint: 'http://127.0.0.1:8333',
  forcePathStyle: true,
  region: 'us-east-2',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
/** The documents filesystem's bucket, as `.env.serve` names it. */
const DOCUMENTS_BUCKET = 'research-brief-documents';
const SESSION_BUCKET = 'beruangai-research-brief-sessions';

let briefer: ResearchBriefClient['briefer'];
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
  briefer = researchBriefClient.local().briefer;
});

describe('the briefer on strands, locally', () => {
  it('briefs from a corpus, citing each document in its own words, and keeps the terms it defines', async () => {
    const corpus = `e2e-${randomUUIDv7()}`;
    const glossary = `e2e-${randomUUIDv7()}`;
    const documents = await corpusDocuments();
    await uploadCorpus(LOCAL_STORE, DOCUMENTS_BUCKET, corpus, documents);

    const ended = await awaitTask(
      briefer.Brief,
      await briefer.Brief.SendMessage(
        { corpus, glossary, question: QUESTION },
        newContext(),
      ),
      POLL_OPTIONS,
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(
        `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
      );
    }
    expect(ended.output.documents).toBe(documents.size);
    for (const claim of ended.output.claims) {
      for (const citation of claim.citations) {
        expect(documents.get(citation.document)).toContain(citation.quote);
      }
    }
    const [run] = ended.runs;
    if (run === undefined) throw new Error('the task records no run');
    expect(run).toMatchObject({ framework: { name: 'strands' } });

    // The glossary is kept beside the agent's sessions, under its space.
    const kept = await LOCAL_STORE.send(
      new ListObjectsV2Command({
        Bucket: SESSION_BUCKET,
        Prefix: `briefer/memory/${glossary}/`,
      }),
    );
    expect(kept.Contents?.length ?? 0).toBeGreaterThan(0);
  });

  it('fails a corpus that holds no documents, before the model is asked', async () => {
    const ended = await awaitTask(
      briefer.Brief,
      await briefer.Brief.SendMessage(
        {
          corpus: `e2e-empty-${randomUUIDv7()}`,
          glossary: `e2e-${randomUUIDv7()}`,
          question: 'What does the corpus say?',
        },
        newContext(),
      ),
      POLL_OPTIONS,
    );
    expect(ended).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'EXECUTION_ERROR' },
    });
    expect(ended.runs).toEqual([]);
  });
});
