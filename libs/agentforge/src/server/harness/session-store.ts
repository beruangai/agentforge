import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { S3Client } from '@aws-sdk/client-s3';
import { AGENT_NAME_VARIABLE } from '#core/agent-name.ts';
import { s3ClientConfiguration } from '#core/s3-endpoint.ts';
import { S3SessionStore } from '#core/s3-session-store.ts';
import { SESSION_BUCKET_VARIABLE } from '#core/session-store.ts';

/**
 * The store the deployment declares — the construct's bucket, or the local
 * store's that `serve` names — for every run in this task process, under the
 * agent's name the executor gives it; none where no bucket is named.
 */
export function sessionStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SessionStore | undefined {
  const bucket = environment[SESSION_BUCKET_VARIABLE];
  if (bucket === undefined || bucket === '') return undefined;
  const prefix = environment[AGENT_NAME_VARIABLE];
  if (prefix === undefined || prefix === '') {
    throw new Error(
      `${SESSION_BUCKET_VARIABLE} names a session bucket, but ${AGENT_NAME_VARIABLE} is unset: transcripts are kept under the agent's name`,
    );
  }
  return new S3SessionStore({
    bucket,
    prefix,
    client: new S3Client(s3ClientConfiguration(environment)),
  });
}
