import { describe, expect, it } from 'vitest';
import { S3SessionStore } from '#core/s3-session-store.ts';
import { sessionStoreFromEnvironment } from './session-store.ts';

describe('sessionStoreFromEnvironment', () => {
  it('declares no store where no bucket is named', () => {
    expect(sessionStoreFromEnvironment({})).toBeUndefined();
  });

  it("stores in the bucket the construct names, under the agent's name", () => {
    expect(
      sessionStoreFromEnvironment({
        AGENTFORGE_SESSION_BUCKET: 'bucket',
        AGENTFORGE_AGENT_NAME: 'writer',
        AWS_REGION: 'us-east-2',
      }),
    ).toBeInstanceOf(S3SessionStore);
  });

  it('refuses a bucket named without the agent name its keys need', () => {
    expect(() =>
      sessionStoreFromEnvironment({
        AGENTFORGE_SESSION_BUCKET: 'bucket',
        AWS_REGION: 'us-east-2',
      }),
    ).toThrow(
      "AGENTFORGE_SESSION_BUCKET names a session bucket, but AGENTFORGE_AGENT_NAME is unset: transcripts are kept under the agent's name",
    );
  });
});
