import { z } from 'zod';

/**
 * The S3 buckets an agent's filesystems may use, as `{ name: bucket }` JSON,
 * named by the `AgentRuntime` construct — or, served locally, by the
 * consumer's `.env.serve.local` — and read by the harness (ADR 0015).
 */
export const FILESYSTEM_BUCKETS_VARIABLE = 'AGENTFORGE_FILESYSTEM_BUCKETS';

/** A filesystem's or a bucket's name: what a procedure registers it by. */
export const FILESYSTEM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const DeclaredBucketsSchema = z.record(z.string(), z.string().min(3));

/** The deployment's `{ name: bucket }`; none when it declares none. A malformed value names the variable. */
export function parseDeclaredBuckets(
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch (error) {
    throw new Error(`${FILESYSTEM_BUCKETS_VARIABLE} is not JSON`, {
      cause: error,
    });
  }
  const parsed = DeclaredBucketsSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${FILESYSTEM_BUCKETS_VARIABLE} is not a JSON object of bucket names: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}
