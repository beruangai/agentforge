import { execFile } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CreateBucketCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestSnapshotKey } from '../../../src/framework/strands/core/session-keys.ts';
import { submit } from '../../../src/framework/strands/harness/__fixtures__/run-scripted.ts';
import {
  type ScriptedAnthropic,
  scriptedAnthropic,
} from '../../../src/framework/strands/harness/__fixtures__/scripted-anthropic.ts';
import localStoreExecutor, {
  LOCAL_STORE_HOST_ENDPOINTS,
} from '../../../src/plugin/executors/local-store/executor.ts';

const RUN_ONCE = fileURLToPath(
  new URL('./__fixtures__/run-once.ts', import.meta.url),
);
/** The local store takes any key; the variables keep the S3 client off the operator's profiles. */
const LOCAL_CREDENTIALS = {
  AWS_ACCESS_KEY_ID: 'local',
  AWS_SECRET_ACCESS_KEY: 'local',
  AWS_REGION: 'us-east-2',
};
const BUCKET = `strands-storage-${randomUUIDv7()}`;
const AGENT = 'writer';

let api: ScriptedAnthropic;

beforeAll(async () => {
  await localStoreExecutor({});
  await new S3Client({
    endpoint: LOCAL_STORE_HOST_ENDPOINTS.s3,
    forcePathStyle: true,
    region: LOCAL_CREDENTIALS.AWS_REGION,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  }).send(new CreateBucketCommand({ Bucket: BUCKET }));
  api = await scriptedAnthropic([
    submit({ answer: 'first' }),
    submit({ answer: 'second' }),
  ]);
});

afterAll(async () => {
  await api?.close();
});

/** One run in its own `bun` process; the scripted API stays served from this one. */
async function runOnce(
  ...args: string[]
): Promise<{ sessionId: string; output: unknown }> {
  const { AWS_PROFILE: _, ...environment } = process.env;
  const { stdout } = await promisify(execFile)('bun', [RUN_ONCE, ...args], {
    encoding: 'utf8',
    env: {
      ...environment,
      ...LOCAL_CREDENTIALS,
      AGENTFORGE_S3_ENDPOINT: LOCAL_STORE_HOST_ENDPOINTS.s3,
      AGENTFORGE_SESSION_BUCKET: BUCKET,
      AGENTFORGE_AGENT_NAME: AGENT,
      SCRIPTED_ANTHROPIC_URL: api.clientConfig.baseURL,
    },
  });
  const line = stdout.trim().split('\n').at(-1) ?? '';
  return JSON.parse(line) as { sessionId: string; output: unknown };
}

describe('strands storage, on the local store', () => {
  it("resumes a session in a second process, from the agent's prefix in the session bucket", async () => {
    const first = await runOnce('remember the code 42');
    const keys = await new S3Client({
      endpoint: LOCAL_STORE_HOST_ENDPOINTS.s3,
      forcePathStyle: true,
      region: LOCAL_CREDENTIALS.AWS_REGION,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    }).send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `${AGENT}/` }));
    expect(keys.Contents?.map((object) => object.Key)).toContain(
      `${AGENT}/${latestSnapshotKey(first.sessionId)}`,
    );

    const second = await runOnce('what was the code?', first.sessionId);
    expect(second).toEqual({
      sessionId: first.sessionId,
      output: { answer: 'second' },
    });
    expect(JSON.stringify(api.requests[1]?.messages)).toContain(
      'remember the code 42',
    );
  });
});
