import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { runCommand } from '../../__fixtures__/run-command.ts';

/**
 * Everything the layered-image test starts, created before it and removed
 * after it. Every name carries `agentforge-integ-image-determinism`, and the
 * registry container is labelled, so a leftover is identifiable:
 *
 *   - a throwaway `registry:2`, standing in for the registry an image is pushed
 *     to. It sits BETWEEN the levels because the builder below cannot see
 *     images in the daemon: a parent `--load`ed into the daemon does not
 *     resolve as a `FROM`, so each level is pushed and the next pulls it.
 *   - a `docker-container` buildx builder whose buildkitd config trusts that
 *     registry over http. The default `docker` driver cannot export OCI at all,
 *     and its `docker` exporter does not rewrite layer timestamps — so neither
 *     can produce the manifest digest this test compares.
 *   - a `DOCKER_CONFIG` without the macOS keychain credential helper, which
 *     blocks without an interactive unlock and makes every pull fail as
 *     `error getting credentials - err: signal: terminated` — reading like a
 *     network fault. Pulls are anonymous, which is all the test needs.
 */
export interface BuildxEnvironment {
  readonly scratchDirectory: string;
  readonly builderName: string;
  readonly registryAddress: string;
  /** The process environment every docker command runs with, without `SOURCE_DATE_EPOCH`. */
  readonly environment: NodeJS.ProcessEnv;
}

const resourcePrefix = 'agentforge-integ-image-determinism';
const registryContainerName = `${resourcePrefix}-registry`;
const registryLabel = 'agentforge.integ=image-determinism';
const builderName = resourcePrefix;
/** buildx's own name for the container a `docker-container` builder runs in. */
const builderContainerName = `buildx_buildkit_${builderName}0`;
const registryHostPort = 5001;
/** How the builder, on the host network, reaches the registry published on the host. */
const registryAddress = `host.docker.internal:${registryHostPort}`;

interface CreatedResources {
  scratchDirectory?: string;
  environment?: NodeJS.ProcessEnv;
  registryContainer?: boolean;
  builder?: boolean;
}

export async function createBuildxEnvironment(): Promise<BuildxEnvironment> {
  const created: CreatedResources = {};
  try {
    await assertDockerDaemonReachable();
    await assertBuildxInstalled();
    await assertNoLeftoverContainer(registryContainerName);
    await assertNoLeftoverContainer(builderContainerName);

    created.scratchDirectory = await mkdtemp(
      join(tmpdir(), `${resourcePrefix}-`),
    );
    const dockerConfigDirectory = join(
      created.scratchDirectory,
      'docker-config',
    );
    await writeDockerConfigWithoutCredentialHelper(dockerConfigDirectory);
    const environment = environmentFor(dockerConfigDirectory);
    created.environment = environment;

    await runCommand(
      'docker',
      [
        'run',
        '--detach',
        '--name',
        registryContainerName,
        '--label',
        registryLabel,
        '--publish',
        `${registryHostPort}:5000`,
        'registry:2',
      ],
      {
        purpose: `Starting the throwaway registry on host port ${registryHostPort}`,
        environment,
      },
    );
    created.registryContainer = true;
    await waitForRegistry(`http://localhost:${registryHostPort}/v2/`);

    const buildkitdConfiguration = join(
      created.scratchDirectory,
      'buildkitd.toml',
    );
    await writeFile(
      buildkitdConfiguration,
      `[registry."${registryAddress}"]\n  http = true\n  insecure = true\n`,
    );
    // Marked before the call: a create that fails halfway can leave the
    // container behind, and teardown must then find and remove it.
    created.builder = true;
    await runCommand(
      'docker',
      [
        'buildx',
        'create',
        '--name',
        builderName,
        '--driver',
        'docker-container',
        '--driver-opt',
        'network=host',
        '--config',
        buildkitdConfiguration,
        '--bootstrap',
      ],
      { purpose: 'Creating the docker-container buildx builder', environment },
    );

    return {
      scratchDirectory: created.scratchDirectory,
      builderName,
      registryAddress,
      environment,
    };
  } catch (setupError) {
    await removeCreatedResources(created).catch((teardownError: unknown) => {
      throw new AggregateError(
        [setupError, teardownError],
        'Setting up the buildx environment failed, and so did removing what it had created',
      );
    });
    throw setupError;
  }
}

/** Removes everything, attempting every step; any failure throws, naming each. */
export async function removeBuildxEnvironment(
  environment: BuildxEnvironment,
): Promise<void> {
  await removeCreatedResources({
    scratchDirectory: environment.scratchDirectory,
    environment: environment.environment,
    registryContainer: true,
    builder: true,
  });
}

async function removeCreatedResources(
  created: CreatedResources,
): Promise<void> {
  const environment = created.environment ?? process.env;
  const { scratchDirectory } = created;
  const outcomes = await Promise.allSettled([
    // `buildx rm` removes the builder container and its state volume.
    created.builder === true
      ? runCommand('docker', ['buildx', 'rm', builderName], {
          purpose: `Removing buildx builder ${builderName}`,
          environment,
        })
      : undefined,
    // `--volumes` too: registry:2 declares an anonymous volume for its storage.
    created.registryContainer === true
      ? runCommand(
          'docker',
          ['rm', '--force', '--volumes', registryContainerName],
          {
            purpose: `Removing registry container ${registryContainerName}`,
            environment,
          },
        )
      : undefined,
  ]);
  // The scratch directory holds the DOCKER_CONFIG the removals above run with.
  const directoryOutcome = await Promise.allSettled([
    scratchDirectory === undefined
      ? undefined
      : rm(scratchDirectory, { recursive: true }),
  ]);
  const failures = [...outcomes, ...directoryOutcome].flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Tearing down the image-determinism environment failed; look for leftovers named ${resourcePrefix}*`,
    );
  }
}

async function assertDockerDaemonReachable(): Promise<void> {
  await runCommand('docker', ['version', '--format', '{{.Server.Version}}'], {
    purpose: 'Prerequisite: a reachable Docker daemon',
  });
}

async function assertBuildxInstalled(): Promise<void> {
  await runCommand('docker', ['buildx', 'version'], {
    purpose: 'Prerequisite: the docker buildx plugin',
  });
}

async function assertNoLeftoverContainer(containerName: string): Promise<void> {
  const { stdout } = await runCommand(
    'docker',
    ['ps', '--all', '--quiet', '--filter', `name=^/${containerName}$`],
    { purpose: `Looking for a leftover ${containerName}` },
  );
  if (stdout.trim() !== '') {
    throw new Error(
      `A container named ${containerName} is left over from an earlier run whose teardown failed. Remove it with \`docker rm --force --volumes ${containerName}\`${containerName === builderContainerName ? ` and \`docker volume rm ${containerName.replace(/0$/, '')}_state\`` : ''}, then re-run.`,
    );
  }
}

async function waitForRegistry(url: string): Promise<void> {
  await vi.waitFor(
    async () => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(
          `The throwaway registry at ${url} answered ${response.status}`,
        );
      }
    },
    { timeout: 30_000, interval: 250 },
  );
}

/**
 * A `DOCKER_CONFIG` carrying only the current context, with the user's context
 * definitions and CLI plugins linked in so `docker` and `docker buildx` reach
 * the same daemon. No `credsStore`, no `credHelpers`, no `auths`. buildx's own
 * state is not linked, so the builder is recorded here and nowhere else.
 */
async function writeDockerConfigWithoutCredentialHelper(
  dockerConfigDirectory: string,
): Promise<void> {
  const sourceDirectory =
    process.env.DOCKER_CONFIG ?? join(homedir(), '.docker');
  await mkdir(dockerConfigDirectory, { recursive: true });
  const sourceConfigurationPath = join(sourceDirectory, 'config.json');
  const sourceConfiguration = existsSync(sourceConfigurationPath)
    ? (JSON.parse(await readFile(sourceConfigurationPath, 'utf8')) as {
        currentContext?: string;
      })
    : {};
  const configuration =
    sourceConfiguration.currentContext === undefined
      ? { auths: {} }
      : { auths: {}, currentContext: sourceConfiguration.currentContext };
  await writeFile(
    join(dockerConfigDirectory, 'config.json'),
    JSON.stringify(configuration, null, 2),
  );
  for (const part of ['contexts', 'cli-plugins']) {
    const source = join(sourceDirectory, part);
    if (existsSync(source)) {
      await symlink(source, join(dockerConfigDirectory, part));
    }
  }
}

function environmentFor(dockerConfigDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerConfigDirectory,
  };
  // Every build states its own epoch; none inherits one from the shell.
  delete environment.SOURCE_DATE_EPOCH;
  delete environment.BUILDX_BUILDER;
  return environment;
}

export interface ImageBuild {
  readonly contextDirectory: string;
  /** Repository under the throwaway registry, e.g. `agentforge/a2a-claude`. */
  readonly repository: string;
  readonly buildArguments: Readonly<Record<string, string>>;
  /** Set as the build's `SOURCE_DATE_EPOCH`, or left unset when `undefined`. */
  readonly sourceDateEpoch: string | undefined;
  readonly rewriteTimestamp: boolean;
  readonly noCache: boolean;
}

let metadataSequence = 0;

/**
 * Builds for `linux/arm64`, pushes to the throwaway registry, and returns the
 * MANIFEST digest buildx itself reports as `containerimage.digest` in
 * `--metadata-file` — the artifact a registry serves. Not the image id: the
 * `docker` exporter's id moves on every build even under `SOURCE_DATE_EPOCH`,
 * so it is no change signal at all. `--provenance=false`, because provenance
 * attestations embed build metadata and turn the manifest into an index whose
 * digest moves per build.
 */
export async function buildAndReadManifestDigest(
  buildxEnvironment: BuildxEnvironment,
  build: ImageBuild,
): Promise<string> {
  metadataSequence += 1;
  const metadataFile = join(
    buildxEnvironment.scratchDirectory,
    `metadata-${metadataSequence}.json`,
  );
  const output = [
    'type=registry',
    `name=${buildxEnvironment.registryAddress}/${build.repository}:integ`,
    ...(build.rewriteTimestamp ? ['rewrite-timestamp=true'] : []),
  ].join(',');
  const environment: NodeJS.ProcessEnv = { ...buildxEnvironment.environment };
  if (build.sourceDateEpoch !== undefined) {
    environment.SOURCE_DATE_EPOCH = build.sourceDateEpoch;
  }
  await runCommand(
    'docker',
    [
      'buildx',
      'build',
      '--builder',
      buildxEnvironment.builderName,
      '--platform',
      'linux/arm64',
      '--provenance=false',
      '--progress=plain',
      ...(build.noCache ? ['--no-cache'] : []),
      '--output',
      output,
      '--metadata-file',
      metadataFile,
      ...Object.entries(build.buildArguments).flatMap(([name, value]) => [
        '--build-arg',
        `${name}=${value}`,
      ]),
      build.contextDirectory,
    ],
    { purpose: `Building ${build.repository}`, environment },
  );
  const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as Record<
    string,
    unknown
  >;
  const digest = metadata['containerimage.digest'];
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new Error(
      `buildx metadata for ${build.repository} has no manifest digest in containerimage.digest: ${JSON.stringify(metadata)}`,
    );
  }
  return digest;
}
