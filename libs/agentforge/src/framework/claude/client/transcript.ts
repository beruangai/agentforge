// biome-ignore-start lint/style/noRestrictedImports: types only, which compile away (ARCHITECTURE.md §8)
import type {
  SessionMessage,
  SessionStore,
} from '@anthropic-ai/claude-agent-sdk';
// biome-ignore-end lint/style/noRestrictedImports: -
import type { S3Client } from '@aws-sdk/client-s3';
import type { RunRecord } from '#core/contract/task.ts';

/**
 * A run's transcript, read from where its record says the deployment's store
 * keeps it (§REQ601), as the Agent SDK's session messages. The caller's role
 * needs the project construct's `grantReadTranscripts`; locally, the S3
 * client's endpoint is the local store's, from `AGENTFORGE_S3_ENDPOINT` or
 * `client`. The Agent SDK and the S3 client load on the first call, so a
 * caller that never reads a transcript needs neither.
 */
export async function readTranscript(
  run: Pick<RunRecord, 'framework' | 'sessionId' | 'transcript'>,
  options: { readonly client?: S3Client } = {},
): Promise<SessionMessage[]> {
  const { sessionId, transcript } = run;
  if (run.framework.name !== 'claude') {
    throw new Error(
      `the run went through the ${run.framework.name} framework: its own client reads its session`,
    );
  }
  if (sessionId === undefined || transcript === undefined) {
    throw new Error(
      "the run records no transcript: it started no session, or kept it in a procedure's own store",
    );
  }
  const { projectKey } = transcript;
  if (projectKey === undefined) {
    throw new Error('the run records its transcript without a project key');
  }
  const [{ getSessionMessages }, { S3Client }, { S3SessionStore }, endpoint] =
    await Promise.all([
      // biome-ignore lint/style/noRestrictedImports: loaded only when a caller reads a transcript (ARCHITECTURE.md §8)
      import('@anthropic-ai/claude-agent-sdk'),
      import('@aws-sdk/client-s3'),
      import('../core/s3-session-store.ts'),
      import('#core/s3-endpoint.ts'),
    ]);
  const store = new S3SessionStore({
    bucket: transcript.bucket,
    prefix: transcript.agent,
    client: options.client ?? new S3Client(endpoint.s3ClientConfiguration()),
  });
  // Read at the recorded key, whatever project key the SDK derives from the
  // directory it is given.
  const recorded: SessionStore = {
    append: () =>
      Promise.reject(new Error('a transcript is read here, never written')),
    load: (key) => store.load({ ...key, projectKey }),
    listSubkeys: (key) => store.listSubkeys({ ...key, projectKey }),
  };
  const messages = await getSessionMessages(sessionId, {
    sessionStore: recorded,
    dir: '/',
  });
  if (messages.length === 0) {
    throw new Error(
      `no transcript at s3://${transcript.bucket}/${transcript.agent}/${projectKey}/${sessionId}/`,
    );
  }
  return messages;
}
