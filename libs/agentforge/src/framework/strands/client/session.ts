import type { S3Client } from '@aws-sdk/client-s3';
import type { Message, MessageData } from '@strands-agents/sdk';
import type { RunRecord } from '#core/contract/task.ts';
import { latestSnapshotKey } from '../core/session-keys.ts';

/**
 * A run's session, read from where its record says the deployment's storage
 * keeps it (§REQ601), as Strands' messages. The caller's role needs the
 * project construct's `grantReadTranscripts`; locally, the S3 client's
 * endpoint is the local store's, from `AGENTFORGE_S3_ENDPOINT` or `client`.
 * The SDK and the S3 client load on the first call, so a caller that never
 * reads a session needs neither.
 */
export async function readSession(
  run: Pick<RunRecord, 'framework' | 'sessionId' | 'transcript'>,
  options: { readonly client?: S3Client } = {},
): Promise<readonly Message[]> {
  if (run.framework.name !== 'strands') {
    throw new Error(
      `the run went through the ${run.framework.name} framework: its own client reads its session`,
    );
  }
  const { sessionId, transcript } = run;
  if (sessionId === undefined || transcript === undefined) {
    throw new Error(
      'the run records no session: the deployment named no session bucket',
    );
  }
  const [{ Message }, { S3Storage }, { S3Client }, endpoint] =
    await Promise.all([
      import('@strands-agents/sdk'),
      import('@strands-agents/sdk/storage'),
      import('@aws-sdk/client-s3'),
      import('#core/s3-endpoint.ts'),
    ]);
  const storage = new S3Storage(transcript.bucket, {
    prefix: `${transcript.agent}/`,
    s3Client: options.client ?? new S3Client(endpoint.s3ClientConfiguration()),
  });
  const key = latestSnapshotKey(sessionId);
  const data = await storage.read(key);
  if (data === null) {
    throw new Error(
      `no session at s3://${transcript.bucket}/${transcript.agent}/${key}`,
    );
  }
  const snapshot = JSON.parse(new TextDecoder().decode(data)) as {
    data?: { messages?: MessageData[] };
  };
  const messages = snapshot.data?.messages;
  if (!Array.isArray(messages)) {
    throw new Error(
      `the session at s3://${transcript.bucket}/${transcript.agent}/${key} holds no messages`,
    );
  }
  return messages.map((message) => Message.fromMessageData(message));
}
