/**
 * The whole path on AgentCore: a caller, through the project client resolved
 * from the deployment's runtime configuration, to the briefer as
 * research-brief-infra's `deploy` left it, as the test role. The corpus is
 * read from the documents bucket the caller filled, each claim cites it in
 * its own words, and the glossary is kept in the project's session bucket.
 */
import { randomUUIDv7 } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { awaitTask } from '@beruangai/agentforge/client';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type Client as ResearchBriefClient,
  client as researchBriefClient,
} from '../../client.ts';
import {
  corpusDocuments,
  QUESTION,
  uploadCorpus,
} from '../__fixtures__/corpus.ts';

const OUTPUTS_FILE = new URL(
  '../../../../../dist/packages/examples/research-brief-infra/deploy/outputs.json',
  import.meta.url,
);
const STACK_NAME = 'agentforge-example-research-brief-Application';
const OutputsSchema = z.object({
  [STACK_NAME]: z.object({
    RuntimeConfigApplicationId: z.string(),
    SessionBucketName: z.string(),
    DocumentsBucketName: z.string(),
  }),
});

/** AgentCore requires at least 33 characters. */
const newContext = () => ({
  runtimeSessionId: `e2e-${randomUUIDv7()}`,
  idempotencyKey: randomUUIDv7(),
});
const POLL_INTERVAL_MILLISECONDS = 2_000;

let briefer: ResearchBriefClient['briefer'];
let outputs: z.infer<typeof OutputsSchema>[typeof STACK_NAME];
const s3 = new S3Client({});

beforeAll(async () => {
  outputs = OutputsSchema.parse(
    JSON.parse(await readFile(OUTPUTS_FILE, 'utf8')),
  )[STACK_NAME];
  briefer = (
    await researchBriefClient.fromRuntimeConfig({
      applicationId: outputs.RuntimeConfigApplicationId,
    })
  ).briefer;
});

describe('the briefer, on AgentCore', () => {
  it('briefs from a corpus in S3, citing each document in its own words, and keeps its glossary in the session bucket', async () => {
    const corpus = `e2e-${randomUUIDv7()}`;
    const glossary = `e2e-${randomUUIDv7()}`;
    const documents = await corpusDocuments();
    await uploadCorpus(s3, outputs.DocumentsBucketName, corpus, documents);

    const context = newContext();
    const ended = await awaitTask(
      briefer.Brief,
      await briefer.Brief.SendMessage(
        { corpus, glossary, question: QUESTION },
        context,
      ),
      { ...context, pollIntervalMilliseconds: POLL_INTERVAL_MILLISECONDS },
    );
    if (ended.state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`expected completion, got ${JSON.stringify(ended)}`);
    }
    expect(ended.output.documents).toBe(documents.size);
    for (const claim of ended.output.claims) {
      for (const citation of claim.citations) {
        expect(documents.get(citation.document)).toContain(citation.quote);
      }
    }
    expect(ended.runs[0]?.usage?.outputTokens).toBeGreaterThan(0);

    const kept = await s3.send(
      new ListObjectsV2Command({
        Bucket: outputs.SessionBucketName,
        Prefix: `briefer/memory/${glossary}/`,
      }),
    );
    expect(kept.Contents?.length ?? 0).toBeGreaterThan(0);
  });
});
