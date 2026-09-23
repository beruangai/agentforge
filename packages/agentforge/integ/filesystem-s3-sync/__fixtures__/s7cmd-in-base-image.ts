/**
 * The `s7cmd` release the base image will install, obtained and run the way the
 * base image will run it.
 *
 * `s7cmd` is a personal project whose dependencies are updated best-effort, so
 * it is pinned by the sha256 its release publishes. The pin is the thing that
 * needs re-checking: bumping {@link s7cmdVersion} and
 * {@link s7cmdArchiveSha256} together and re-running the suite is how a new
 * release is admitted. Anything else that moves the pin — the release
 * re-publishing the asset, or its published `.sha256` — fails loudly here.
 *
 * The binary runs inside the Alpine base on `linux/arm64`, not on the host,
 * because the risk the design note did not name is musl: a glibc build would
 * not run in the base image, and a host binary would hide that.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { pinnedBunBaseImageReference } from '../../__fixtures__/pinned-base-image.ts';
import { testOutputDirectory } from '../../__fixtures__/test-output-directory.ts';

const execFileAsync = promisify(execFile);

export const s7cmdVersion = '1.8.3';

export const s7cmdArchiveName = `s7cmd-${s7cmdVersion}-linux-musl-aarch64.tar.gz`;

/**
 * Copied from the release's published
 * `s7cmd-1.8.3-linux-musl-aarch64.tar.gz.sha256` on 2026-09-23, and equal to
 * the digest GitHub reports for the asset.
 */
export const s7cmdArchiveSha256 =
  '1ffd41f6a01229f5a949bc322807b03cb59cecd31561a488222e2923e5056348';

const s7cmdReleaseUrl = `https://github.com/nidor1998/s7cmd/releases/download/v${s7cmdVersion}`;

/** The external base the AgentForge base image is built `FROM` — one pin, shared. */
export const baseImage = pinnedBunBaseImageReference;

export const baseImagePlatform = 'linux/arm64';

/** The target triple `s7cmd --version` reports for the musl aarch64 build. */
export const s7cmdTargetTriple = 'aarch64-unknown-linux-musl';

/**
 * Under the gitignored output root (`dist/packages/agentforge/test-output/`). Only a verified archive is ever renamed into
 * it, so a digest mismatch at rest means something changed the file after it
 * was verified — which is reported, never repaired by re-downloading.
 */
const s7cmdCacheDirectory = join(testOutputDirectory, 's7cmd', s7cmdVersion);

const containerArchivePath = '/opt/s7cmd/s7cmd.tar.gz';

/** Where {@link runInBaseImage} mounts the host's working area. */
export const containerWorkspacePath = '/workspace';

function sha256Hex(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function fetchOrThrow(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `GET ${url} answered ${response.status} ${response.statusText}`,
    );
  }
  return response;
}

/**
 * The published `.sha256` is read on every run, cached archive or not, so a
 * release that re-publishes its digest is noticed without re-downloading the
 * archive.
 */
async function assertPublishedDigestIsPinned(): Promise<void> {
  const response = await fetchOrThrow(
    `${s7cmdReleaseUrl}/${s7cmdArchiveName}.sha256`,
  );
  const publishedLine = (await response.text()).trim();
  const expectedLine = `${s7cmdArchiveSha256}  ${s7cmdArchiveName}`;
  if (publishedLine !== expectedLine) {
    throw new Error(
      `The published ${s7cmdArchiveName}.sha256 no longer matches the pin.\n` +
        `  pinned:    ${expectedLine}\n  published: ${publishedLine}`,
    );
  }
}

/**
 * Returns the path of the pinned archive on the host, downloading it on first
 * use and verifying its sha256 against {@link s7cmdArchiveSha256} every time.
 */
export async function resolveVerifiedS7cmdArchive(): Promise<string> {
  await assertPublishedDigestIsPinned();
  const archivePath = join(s7cmdCacheDirectory, s7cmdArchiveName);

  const cachedArchive = await readFile(archivePath).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  if (cachedArchive !== undefined) {
    const cachedSha256 = sha256Hex(cachedArchive);
    if (cachedSha256 !== s7cmdArchiveSha256) {
      throw new Error(
        `The cached ${archivePath} no longer matches the pin — it was verified ` +
          `when cached, so something has changed it since.\n` +
          `  pinned: ${s7cmdArchiveSha256}\n  cached: ${cachedSha256}`,
      );
    }
    return archivePath;
  }

  const response = await fetchOrThrow(`${s7cmdReleaseUrl}/${s7cmdArchiveName}`);
  const downloadedArchive = Buffer.from(await response.arrayBuffer());
  const downloadedSha256 = sha256Hex(downloadedArchive);
  if (downloadedSha256 !== s7cmdArchiveSha256) {
    throw new Error(
      `The downloaded ${s7cmdArchiveName} does not match the pin — the release ` +
        `asset has been re-published.\n` +
        `  pinned:     ${s7cmdArchiveSha256}\n  downloaded: ${downloadedSha256}`,
    );
  }
  await mkdir(s7cmdCacheDirectory, { recursive: true });
  const partialPath = `${archivePath}.${process.pid}.partial`;
  await writeFile(partialPath, downloadedArchive);
  await rename(partialPath, archivePath).catch(async (error: unknown) => {
    await rm(partialPath, { force: true });
    throw error;
  });
  return archivePath;
}

export interface BaseImageRun {
  archivePath: string;
  /** Host directory mounted read-write at {@link containerWorkspacePath}. */
  workspaceHostPath: string;
  /**
   * Passed by name (`-e NAME`) so values never reach the process list. Docker
   * silently drops a named variable that is unset on the host; every value
   * here is set in the `docker` process's environment, and an empty one is
   * rejected rather than passed.
   *
   * Nothing else reaches the container, and that matters: `s7cmd` also reads
   * its options from environment variables (`--delete` from `DELETE`), so a
   * stray variable could turn delete propagation on without a flag.
   */
  environment: Record<string, string>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Where the verified archive's `s7cmd` is extracted inside the container. */
export const s7cmdContainerPath = '/tmp/s7cmd';

/**
 * Extracts the verified archive inside the base image and runs `executable`
 * there with `executableArguments`, passed as `"$@"` so nothing is re-quoted.
 * The host user's uid and gid run it, so whatever it writes into the workspace
 * the host can remove.
 *
 * A non-zero exit is returned, not thrown — the static-linkage check expects
 * one. Anything that stops the command running at all throws.
 */
export async function runInBaseImage(
  run: BaseImageRun,
  executable: string,
  executableArguments: string[],
): Promise<CommandResult> {
  if (process.getuid === undefined || process.getgid === undefined) {
    throw new Error(
      'process.getuid/getgid are unavailable; a POSIX host is needed',
    );
  }
  for (const [name, value] of Object.entries(run.environment)) {
    if (value === '') {
      throw new Error(`${name} is empty; the container would not receive it`);
    }
  }

  const dockerArguments = [
    'run',
    '--rm',
    '--platform',
    baseImagePlatform,
    '--user',
    `${process.getuid()}:${process.getgid()}`,
    ...Object.keys(run.environment).flatMap((name) => ['-e', name]),
    '-v',
    `${run.archivePath}:${containerArchivePath}:ro`,
    '-v',
    `${run.workspaceHostPath}:${containerWorkspacePath}`,
    '--entrypoint',
    '/bin/sh',
    baseImage,
    '-c',
    `tar -xzf ${containerArchivePath} -C ${dirname(s7cmdContainerPath)} ${basename(s7cmdContainerPath)} && exec "$0" "$@"`,
    executable,
    ...executableArguments,
  ];
  try {
    const { stdout, stderr } = await execFileAsync('docker', dockerArguments, {
      env: { ...process.env, ...run.environment },
      encoding: 'utf8',
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    if (typeof failure.code !== 'number') throw error;
    return {
      exitCode: failure.code,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    };
  }
}

/**
 * Runs the pinned `s7cmd` in the base image. A non-zero exit throws with the
 * container's output, so a rejected flag can never read as a quiet sync.
 */
export async function runS7cmd(
  run: BaseImageRun,
  s7cmdArguments: string[],
): Promise<CommandResult> {
  const result = await runInBaseImage(run, s7cmdContainerPath, s7cmdArguments);
  if (result.exitCode !== 0) {
    throw new Error(
      `s7cmd ${s7cmdArguments.join(' ')} exited ${result.exitCode}.\n` +
        `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return result;
}
