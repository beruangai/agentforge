import { execFile } from 'node:child_process';
import type { S3Client } from '@aws-sdk/client-s3';
import type {
  S7cmdResult,
  S7cmdRunner,
} from '../../../../src/server/harness/working-directory.ts';
import { AGENTFORGE_BASE_IMAGE } from '../../__fixtures__/agentforge-base-image.ts';

/** The credentials `s7cmd` reads first, handed to the container by name. */
const CREDENTIAL_VARIABLES = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_REGION',
] as const;

/**
 * Runs `s7cmd` inside the base image as built, the way the harness runs it
 * in a container. The host's working area is mounted at the same path, so
 * the harness's paths mean the same inside and out. Credentials are resolved
 * on the host from the test role and passed by name, never on the command
 * line.
 */
export async function s7cmdInBaseImage(
  s3: S3Client,
  mountedDirectory: string,
): Promise<S7cmdRunner> {
  const credentials = await s3.config.credentials();
  if (credentials.sessionToken === undefined) {
    throw new Error('the test role resolved without a session token');
  }
  const environment = {
    ...process.env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken,
    AWS_REGION: await s3.config.region(),
  };
  return (args) =>
    new Promise<S7cmdResult>((resolve) => {
      execFile(
        'docker',
        [
          'run',
          '--rm',
          '--platform',
          'linux/arm64',
          '--volume',
          `${mountedDirectory}:${mountedDirectory}`,
          ...CREDENTIAL_VARIABLES.flatMap((name) => ['--env', name]),
          AGENTFORGE_BASE_IMAGE,
          's7cmd',
          ...args,
        ],
        { env: environment, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
        (error, _stdout, stderr) =>
          resolve({
            exitCode:
              error === null
                ? 0
                : typeof error.code === 'number'
                  ? error.code
                  : -1,
            stderr:
              error !== null && typeof error.code !== 'number'
                ? `${stderr}\n${error.message}`
                : stderr,
          }),
      );
    });
}
