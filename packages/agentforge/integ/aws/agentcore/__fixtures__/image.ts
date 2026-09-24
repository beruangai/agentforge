import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pinnedBunBaseImageReference } from '../../../__fixtures__/pinned-base-image.ts';
import { runCommand } from '../../../__fixtures__/run-command.ts';
import type { AwsEnvironment } from './aws-environment.ts';

const fixturesDirectory = import.meta.dirname;

export interface PushedImage {
  /** `<registry>/<repository>:<tag>`, what `CreateAgentRuntime` is given. */
  readonly imageUri: string;
  /** The manifest digest buildx reports as `containerimage.digest`. */
  readonly digest: string;
}

/**
 * Bundles the fixture server with `bun build --target=bun`, builds it for
 * `linux/arm64` — AgentCore Runtime takes nothing else — on
 * `oven/bun:1.4.0-alpine` pinned by digest, and pushes it to ECR. Docker's
 * layer cache keeps a repeat cheap, so each test file builds its own.
 *
 * The build context and the Docker configuration are temporary directories,
 * removed afterwards, and nothing is written into the repository. There is no
 * `docker login`: the push authenticates through `docker-credential-ecr-login`
 * (awslabs/amazon-ecr-credential-helper), which fetches an ECR token from the
 * task's own `AWS_PROFILE` on each use, so no token is stored anywhere and an
 * expired SSO session fails the push rather than being worked around.
 */
export async function buildAndPushFixtureImage(
  environment: AwsEnvironment,
  repositoryUri: string,
): Promise<PushedImage> {
  const scratchDirectory = await mkdtemp(
    join(tmpdir(), 'agentforge-integ-agentcore-image-'),
  );
  try {
    const contextDirectory = join(scratchDirectory, 'context');
    await mkdir(contextDirectory);
    await cp(
      join(fixturesDirectory, 'Dockerfile'),
      join(contextDirectory, 'Dockerfile'),
    );
    await runCommand(
      'bun',
      [
        'build',
        join(fixturesDirectory, 'server.ts'),
        '--target=bun',
        '--outfile',
        join(contextDirectory, 'server.js'),
      ],
      { purpose: 'Bundling the AgentCore fixture server' },
    );

    const dockerConfigDirectory = join(scratchDirectory, 'docker-config');
    await writeDockerConfigWithEcrCredentialHelper(
      dockerConfigDirectory,
      environment.registry,
    );
    const dockerEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DOCKER_CONFIG: dockerConfigDirectory,
      // The helper otherwise caches tokens under ~/.ecr.
      AWS_ECR_DISABLE_CACHE: 'true',
    };

    const imageUri = `${repositoryUri}:fixture`;
    const metadataFile = join(scratchDirectory, 'metadata.json');
    await runCommand(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        'linux/arm64',
        '--build-arg',
        `BUN_IMAGE=${pinnedBunBaseImageReference}`,
        '--tag',
        imageUri,
        '--metadata-file',
        metadataFile,
        '--provenance=false',
        '--push',
        contextDirectory,
      ],
      {
        purpose: `Building and pushing ${imageUri}`,
        environment: dockerEnvironment,
      },
    );
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as Record<
      string,
      unknown
    >;
    const digest = metadata['containerimage.digest'];
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `buildx metadata for ${imageUri} has no manifest digest in containerimage.digest: ${JSON.stringify(metadata)}`,
      );
    }
    return { imageUri, digest };
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

/**
 * A copy of the operator's Docker configuration whose only credential helper
 * is `ecr-login`, for the one registry the fixture pushes to.
 *
 * `credsStore` is removed because Docker Desktop's `desktop` helper hangs under
 * a non-interactive shell ("error getting credentials — err: signal:
 * terminated"). Removing it does NOT keep credentials out of the keychain: with
 * no `credsStore`, the Docker CLI falls back to the platform's default helper
 * (`docker-credential-osxkeychain`) when it is on `PATH`, which is why a
 * `docker login` per file collided in the keychain when the files ran in
 * parallel (2026-09-24). A registry named in `credHelpers` bypasses that
 * fallback. cli-plugins, contexts and buildx are carried across, or buildx
 * disappears.
 */
export async function writeDockerConfigWithEcrCredentialHelper(
  dockerConfigDirectory: string,
  registry: string,
): Promise<void> {
  await mkdir(dockerConfigDirectory, { recursive: true });
  const sourceDirectory =
    process.env.DOCKER_CONFIG ?? join(homedir(), '.docker');
  const sourceConfigurationPath = join(sourceDirectory, 'config.json');
  const configuration: Record<string, unknown> = existsSync(
    sourceConfigurationPath,
  )
    ? (JSON.parse(await readFile(sourceConfigurationPath, 'utf8')) as Record<
        string,
        unknown
      >)
    : {};
  delete configuration.credsStore;
  delete configuration.auths;
  configuration.credHelpers = { [registry]: 'ecr-login' };
  for (const part of ['cli-plugins', 'contexts', 'buildx']) {
    const source = join(sourceDirectory, part);
    if (existsSync(source)) {
      await cp(source, join(dockerConfigDirectory, part), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
  }
  await writeFile(
    join(dockerConfigDirectory, 'config.json'),
    JSON.stringify(configuration, null, 2),
  );
}
