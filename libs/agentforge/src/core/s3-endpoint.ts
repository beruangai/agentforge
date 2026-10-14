/**
 * An S3-compatible server in place of S3: the local store `serve` runs an
 * agent against. Unset when deployed. Read by every S3 client AgentForge
 * makes, and by `s7cmd`, with path-style addressing, as a local server needs.
 */
export const S3_ENDPOINT_VARIABLE = 'AGENTFORGE_S3_ENDPOINT';

/** The endpoint `environment` names; undefined for S3 itself. */
export function s3Endpoint(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const endpoint = environment[S3_ENDPOINT_VARIABLE];
  return endpoint === undefined || endpoint === '' ? undefined : endpoint;
}

/** An `S3Client`'s configuration for the endpoint `environment` names: S3's own when none. */
export function s3ClientConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): { readonly endpoint?: string; readonly forcePathStyle?: boolean } {
  const endpoint = s3Endpoint(environment);
  return endpoint === undefined ? {} : { endpoint, forcePathStyle: true };
}
