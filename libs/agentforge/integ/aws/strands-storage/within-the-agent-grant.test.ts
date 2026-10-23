/**
 * What Strands sends S3 for an agent's sessions, memory and offloaded
 * results, against a real bucket, stays within what `AgentRuntime` grants an
 * agent on the session bucket: `GetObject` and `PutObject` under its name,
 * and `ListBucket` with a prefix under it. Strands' storage calls can move
 * with the SDK, and a call outside the grant fails only once deployed.
 *
 * The test role cannot take an agent's role, so the commands are recorded
 * and held to the grant; a deployed example runs under the role itself.
 */
import { randomUUIDv7 } from 'node:crypto';
import { S3Client } from '@aws-sdk/client-s3';
import { tool } from '@strands-agents/sdk';
import { S3Storage } from '@strands-agents/sdk/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  runScripted,
  submit,
} from '../../../src/framework/strands/harness/__fixtures__/run-scripted.ts';
import {
  type ScriptedAnthropic,
  scriptedAnthropic,
} from '../../../src/framework/strands/harness/__fixtures__/scripted-anthropic.ts';
import {
  createScratchBucket,
  deleteScratchBucket,
} from '../__fixtures__/scratch-bucket.ts';

const AGENT = 'writer';
/** The S3 calls the agent's grant allows. */
const GRANTED = new Set([
  'GetObjectCommand',
  'PutObjectCommand',
  'ListObjectsV2Command',
]);

const s3 = new S3Client({});
const sent: { readonly command: string; readonly key: string | undefined }[] =
  [];
/** The client the agent's storage uses, recording every command it sends. */
const recorded = new S3Client({});
recorded.middlewareStack.add(
  (next, context) => async (args) => {
    const input = args.input as { Key?: string; Prefix?: string };
    sent.push({
      command: context.commandName ?? 'unknown',
      key: input.Key ?? input.Prefix,
    });
    return next(args);
  },
  { step: 'initialize', name: 'recordCommands' },
);

let bucket: string | undefined;
let api: ScriptedAnthropic | undefined;

beforeAll(async () => {
  bucket = await createScratchBucket(s3, randomUUIDv7());
});

afterAll(async () => {
  await api?.close();
  if (bucket !== undefined) await deleteScratchBucket(s3, bucket);
});

describe('strands storage, on S3', () => {
  it("keeps sessions, memory and offloaded results within the agent's grant", async () => {
    if (bucket === undefined) throw new Error('no scratch bucket');
    api = await scriptedAnthropic([
      {
        toolCalls: [
          { name: 'add_memory', input: { entries: ['the code is 42'] } },
        ],
      },
      { toolCalls: [{ name: 'dump', input: {} }] },
      submit({ answer: 'first' }),
      submit({ answer: 'second' }),
    ]);
    const storage = {
      bucket,
      agent: AGENT,
      storage: new S3Storage(bucket, {
        prefix: `${AGENT}/`,
        s3Client: recorded,
      }),
    };
    const dump = tool({
      name: 'dump',
      description: 'Returns a large result.',
      inputSchema: z.object({}),
      callback: () => 'line of output\n'.repeat(500),
    });
    const first = await runScripted(
      api,
      {
        memorySpace: 'notes',
        offload: { maxResultTokens: 100, previewTokens: 20 },
        options: { model: 'claude-test', maxTokens: 1024, tools: [dump] },
      },
      { storage },
    ).promise;
    const second = await runScripted(
      api,
      { memorySpace: 'notes', resume: first.sessionId },
      { storage },
    ).promise;
    expect(second.output).toEqual({ answer: 'second' });

    const commands = new Set(sent.map(({ command }) => command));
    expect([...commands].filter((command) => !GRANTED.has(command))).toEqual(
      [],
    );
    expect(commands).toEqual(GRANTED);
    expect(sent.filter(({ key }) => !key?.startsWith(`${AGENT}/`))).toEqual([]);
    expect(
      sent.some(({ key }) => key?.startsWith(`${AGENT}/memory/notes/`)),
    ).toBe(true);
    expect(sent.some(({ key }) => key?.startsWith(`${AGENT}/offloader/`))).toBe(
      true,
    );
  });
});
