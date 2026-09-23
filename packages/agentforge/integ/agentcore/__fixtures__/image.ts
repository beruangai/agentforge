import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ECRClient, GetAuthorizationTokenCommand } from '@aws-sdk/client-ecr';
import { pinnedBunBaseImageReference } from '../../__fixtures__/pinned-base-image.ts';
import { runCommand } from '../../__fixtures__/run-command.ts';
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
 * removed afterwards: nothing is written into the repository, and the ECR
 * token `docker login` stores does not outlive the build.
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
    await writeDockerConfigWithoutCredentialHelper(dockerConfigDirectory);
    const dockerEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DOCKER_CONFIG: dockerConfigDirectory,
    };
    await loginToEcr(environment, dockerConfigDirectory, dockerEnvironment);

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

async function loginToEcr(
  environment: AwsEnvironment,
  dockerConfigDirectory: string,
  dockerEnvironment: NodeJS.ProcessEnv,
): Promise<void> {
  const response = await new ECRClient({ region: environment.region }).send(
    new GetAuthorizationTokenCommand({}),
  );
  const token = response.authorizationData?.[0]?.authorizationToken;
  if (token === undefined) {
    throw new Error('ECR GetAuthorizationToken returned no authorizationToken');
  }
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const separator = decoded.indexOf(':');
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  if (separator < 0 || username !== 'AWS' || password === '') {
    throw new Error(
      'ECR authorization token did not decode to "AWS:<password>"',
    );
  }
  // runCommand takes no stdin, so the password reaches `--password-stdin`
  // through a file only this user can read, removed straight after.
  const passwordFile = join(dockerConfigDirectory, 'ecr-password');
  await writeFile(passwordFile, password, { mode: 0o600 });
  try {
    await runCommand(
      'sh',
      [
        '-c',
        'docker login --username AWS --password-stdin "$1" < "$2"',
        'docker-login',
        environment.registry,
        passwordFile,
      ],
      {
        purpose: `Logging in to ${environment.registry}`,
        environment: dockerEnvironment,
      },
    );
  } finally {
    await rm(passwordFile, { force: true });
  }
}

/**
 * Docker Desktop on macOS stores registry credentials in the keychain via
 * `credsStore: desktop`, and the helper hangs under a non-interactive shell
 * ("error getting credentials — err: signal: terminated"). A config directory
 * without `credsStore` or `credHelpers` fixes it, but must carry cli-plugins,
 * contexts and buildx across or buildx disappears.
 */
async function writeDockerConfigWithoutCredentialHelper(
  dockerConfigDirectory: string,
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
  delete configuration.credHelpers;
  delete configuration.auths;
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
