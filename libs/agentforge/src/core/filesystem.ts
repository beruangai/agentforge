import { z } from 'zod';

/**
 * The S3 buckets an agent's filesystems may use, as `{ name: bucket }` JSON,
 * named by the `AgentRuntime` construct — or, served locally, by the
 * consumer's `.env.serve.local` — and read by the harness (ADR 0015).
 */
export const FILESYSTEM_BUCKETS_VARIABLE = 'AGENTFORGE_FILESYSTEM_BUCKETS';

/** A filesystem's or a bucket's name: what a procedure registers it by. */
export const FILESYSTEM_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * The repositories an agent's git filesystems may use, as `{ name: location }`
 * JSON: a remote URL, named by the `AgentRuntime` construct, or, served
 * locally, a host directory the serve target mounts (ADR 0024).
 */
export const FILESYSTEM_REPOSITORIES_VARIABLE =
  'AGENTFORGE_FILESYSTEM_REPOSITORIES';

const DeclaredSchema = z.record(z.string(), z.string().min(1));

/** A deployment's `{ name: store }` from one of the variables above; none when it declares none. A malformed value names the variable. */
export function parseDeclared(
  variable: string,
  value: string | undefined,
): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  let json: unknown;
  try {
    json = JSON.parse(value);
  } catch (error) {
    throw new Error(`${variable} is not JSON`, { cause: error });
  }
  const parsed = DeclaredSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `${variable} is not a JSON object of names: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

/**
 * A repository's remote as a URL, refused unless its scheme is one of
 * `schemes` and it carries no user name or password: a credential belongs
 * to a declared secret, never to a URL that is logged, recorded and
 * written to git's configuration. `subject` names it in the error.
 */
export function parseRepositoryRemote(
  subject: string,
  location: string,
  schemes: readonly ('https:' | 'file:')[],
): URL {
  let url: URL;
  try {
    url = new URL(location);
  } catch (error) {
    throw new Error(`${subject} is not a URL`, { cause: error });
  }
  if (!(schemes as readonly string[]).includes(url.protocol)) {
    throw new Error(
      `${subject} must be ${schemes.map((scheme) => `${scheme}//`).join(' or ')}, not ${url.protocol}//`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      `${subject} carries a credential in its URL: remove it, and authenticate otherwise`,
    );
  }
  return url;
}
