/**
 * §F — does `s7cmd` behave the way working-directory sync assumes?
 *
 * `docs/DESIGN_OPTIONS.md` §F names `s7cmd` as the sync implementation and
 * rests three design choices on it: that `LastModifiedDate` filtering is a
 * usable QUIESCENCE heuristic (leave a file that is mid-write for the next
 * pass), that exclusions work, and that delete propagation is an explicit
 * choice rather than a default. Findings and their date are in
 * `docs/research/working-directory-sync.md`.
 *
 * It is kept as a test because `s7cmd` is a personal project whose
 * dependencies are updated best-effort, pinned by digest — so the pin is
 * exactly what needs re-checking, and a new release is admitted by bumping it
 * and running this suite. It runs the exact archive and libc the base image
 * will, against a real bucket.
 *
 * Every check asserts the exact set of keys it expects. The spike this came
 * from once passed falsely because an empty listing reached a permissive
 * catch-all, so "nothing was uploaded" read as "the right things were
 * uploaded". Naming the full set means a "kept out" check also proves the rest
 * arrived, and an empty result can never pass.
 */

import { randomUUIDv7 } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testOutputDirectory } from '../__fixtures__/test-output-directory.ts';
import {
  type BaseImageRun,
  containerWorkspacePath,
  resolveVerifiedS7cmdArchive,
  runInBaseImage,
  runS7cmd,
  s7cmdContainerPath,
  s7cmdTargetTriple,
  s7cmdVersion,
} from './__fixtures__/s7cmd-in-base-image.ts';
import {
  type AwsForContainer,
  createScratchBucket,
  deleteScratchBucket,
  listRelativeKeys,
  readStoredSha256,
  resolveAwsForContainer,
  sha256Base64,
} from './__fixtures__/scratch-bucket.ts';

/**
 * A working directory shaped like an agent's: source, a build tree, a git
 * directory, and one file still being written.
 */
const agentWorkingDirectoryFiles: Record<string, string> = {
  'src/main.ts': 'source\n',
  'README.md': 'readme\n',
  'node_modules/pkg/index.js': 'dep\n',
  '.git/HEAD': 'gitstuff\n',
  'src/still-being-written.ts': 'half\n',
};
const fileStillBeingWritten = 'src/still-being-written.ts';
const everyFile = Object.keys(agentWorkingDirectoryFiles).sort();

/** Everything but the one still being written was last touched long ago. */
const settledModificationTime = new Date('2026-01-01T00:00:00Z');
const quiescenceThresholdMilliseconds = 30_000;

/** The exclusion the finding was recorded against. */
const buildAndGitExclusion = '(^|/)(\\.git|node_modules)/';

function everyFileExcept(...excluded: string[]): string[] {
  for (const path of excluded) {
    if (!everyFile.includes(path)) {
      throw new Error(`${path} is not in the agent working directory`);
    }
  }
  return everyFile.filter((path) => !excluded.includes(path));
}

interface SuiteState {
  aws: AwsForContainer;
  bucketName: string;
  runId: string;
  runHostDirectory: string;
  baseImageRun: BaseImageRun;
}

interface WorkingDirectory {
  hostPath: string;
  containerPath: string;
}

describe('s7cmd, pinned, in the base image, against a real bucket', () => {
  let runHostDirectory: string | undefined;
  let aws: AwsForContainer | undefined;
  let bucketName: string | undefined;
  let suite: SuiteState | undefined;

  beforeAll(async () => {
    const archivePath = await resolveVerifiedS7cmdArchive();
    aws = await resolveAwsForContainer();
    const runId = randomUUIDv7();
    runHostDirectory = join(testOutputDirectory, 'filesystem-s3-sync', runId);
    await mkdir(runHostDirectory, { recursive: true });
    bucketName = await createScratchBucket(aws, runId);
    suite = {
      aws,
      bucketName,
      runId,
      runHostDirectory,
      baseImageRun: {
        archivePath,
        workspaceHostPath: runHostDirectory,
        environment: aws.containerEnvironment,
      },
    };
  });

  afterAll(async () => {
    try {
      if (aws !== undefined && bucketName !== undefined) {
        await deleteScratchBucket(aws.s3, bucketName);
      }
    } finally {
      if (runHostDirectory !== undefined) {
        await rm(runHostDirectory, { recursive: true });
      }
    }
  });

  function requireSuite(): SuiteState {
    if (suite === undefined) throw new Error('beforeAll did not complete');
    return suite;
  }

  async function createAgentWorkingDirectory(
    name: string,
  ): Promise<WorkingDirectory> {
    const hostPath = join(requireSuite().runHostDirectory, name);
    for (const [relativePath, content] of Object.entries(
      agentWorkingDirectoryFiles,
    )) {
      const filePath = join(hostPath, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content);
      await utimes(filePath, settledModificationTime, settledModificationTime);
    }
    const now = new Date();
    await utimes(join(hostPath, fileStillBeingWritten), now, now);
    return { hostPath, containerPath: `${containerWorkspacePath}/${name}` };
  }

  function prefixFor(check: string): string {
    return `${requireSuite().runId}/${check}/`;
  }

  function syncUp(
    workingDirectory: WorkingDirectory,
    check: string,
    ...options: string[]
  ) {
    const { baseImageRun, bucketName } = requireSuite();
    return runS7cmd(baseImageRun, [
      'sync',
      ...options,
      workingDirectory.containerPath,
      `s3://${bucketName}/${prefixFor(check)}`,
    ]);
  }

  function keysUnder(check: string): Promise<string[]> {
    const { aws, bucketName } = requireSuite();
    return listRelativeKeys(aws.s3, bucketName, prefixFor(check));
  }

  it('the pinned musl aarch64 build runs in the Alpine base, statically linked', async () => {
    const { baseImageRun } = requireSuite();

    const version = await runS7cmd(baseImageRun, ['--version']);
    expect(version.stdout).toMatch(
      new RegExp(
        `^s7cmd ${s7cmdVersion.replaceAll('.', '\\.')} \\(\\S+ ${s7cmdTargetTriple}\\)`,
      ),
    );

    // musl's `ldd` refuses a static binary, which is the finding: no runtime
    // dependency for the base image to install.
    const linkage = await runInBaseImage(baseImageRun, 'ldd', [
      s7cmdContainerPath,
    ]);
    expect(linkage.exitCode).toBe(1);
    expect(linkage.stderr).toContain('Not a valid dynamic program');
  });

  it('local → S3 uploads every file', async () => {
    const workingDirectory = await createAgentWorkingDirectory('plain');
    await syncUp(workingDirectory, 'plain');
    expect(await keysUnder('plain')).toEqual(everyFile);
  });

  it('quiescence: --filter-mtime-before an absolute cutoff leaves the fresh file and uploads the settled ones', async () => {
    const workingDirectory = await createAgentWorkingDirectory('quiescent');
    const now = new Date();
    await utimes(
      join(workingDirectory.hostPath, fileStillBeingWritten),
      now,
      now,
    );
    // The filter takes an absolute timestamp, so the threshold lives in the
    // caller and is recomputed on every pass.
    const cutoff = new Date(now.getTime() - quiescenceThresholdMilliseconds)
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z');

    await syncUp(
      workingDirectory,
      'quiescent',
      '--filter-mtime-before',
      cutoff,
    );

    expect(await keysUnder('quiescent')).toEqual(
      everyFileExcept(fileStillBeingWritten),
    );
  });

  it('exclusions: --filter-exclude-regex keeps .git and node_modules out and uploads the rest', async () => {
    const workingDirectory = await createAgentWorkingDirectory('excluded');
    await syncUp(
      workingDirectory,
      'excluded',
      '--filter-exclude-regex',
      buildAndGitExclusion,
    );
    expect(await keysUnder('excluded')).toEqual(
      everyFileExcept('.git/HEAD', 'node_modules/pkg/index.js'),
    );
  });

  it('delete propagation is OFF by default: a file deleted locally survives in S3', async () => {
    const workingDirectory =
      await createAgentWorkingDirectory('delete-default');
    await syncUp(workingDirectory, 'delete-default');
    expect(await keysUnder('delete-default')).toEqual(everyFile);

    await rm(join(workingDirectory.hostPath, 'README.md'));
    await syncUp(workingDirectory, 'delete-default');

    expect(await keysUnder('delete-default')).toEqual(everyFile);
  });

  it('--delete removes what is gone locally, and only that', async () => {
    const workingDirectory =
      await createAgentWorkingDirectory('delete-explicit');
    await syncUp(workingDirectory, 'delete-explicit');
    expect(await keysUnder('delete-explicit')).toEqual(everyFile);

    await rm(join(workingDirectory.hostPath, 'README.md'));
    await syncUp(workingDirectory, 'delete-explicit', '--delete');

    expect(await keysUnder('delete-explicit')).toEqual(
      everyFileExcept('README.md'),
    );
  });

  it('--dry-run uploads nothing', async () => {
    const workingDirectory = await createAgentWorkingDirectory('dry-run');
    await syncUp(workingDirectory, 'dry-run');
    expect(await keysUnder('dry-run')).toEqual(everyFile);

    await writeFile(join(workingDirectory.hostPath, 'src/added.ts'), 'new\n');
    await syncUp(workingDirectory, 'dry-run', '--dry-run');

    expect(await keysUnder('dry-run')).toEqual(everyFile);
  });

  it('S3 → local round trip brings every file back intact', async () => {
    const { baseImageRun, bucketName } = requireSuite();
    const workingDirectory = await createAgentWorkingDirectory('round-trip');
    await syncUp(workingDirectory, 'round-trip');
    expect(await keysUnder('round-trip')).toEqual(everyFile);

    const downloadHostPath = join(requireSuite().runHostDirectory, 'download');
    await mkdir(downloadHostPath);
    await runS7cmd(baseImageRun, [
      'sync',
      `s3://${bucketName}/${prefixFor('round-trip')}`,
      `${containerWorkspacePath}/download`,
    ]);

    const downloaded = await readdir(downloadHostPath, {
      recursive: true,
      withFileTypes: true,
    });
    const downloadedFiles = downloaded
      .filter((entry) => entry.isFile())
      .map((entry) =>
        join(entry.parentPath, entry.name).slice(downloadHostPath.length + 1),
      )
      .sort();
    expect(downloadedFiles).toEqual(everyFile);
    for (const relativePath of everyFile) {
      expect(
        await readFile(join(downloadHostPath, relativePath), 'utf8'),
        relativePath,
      ).toBe(agentWorkingDirectoryFiles[relativePath]);
    }
  });

  it('--additional-checksum-algorithm SHA256 is accepted, and S3 stores each file’s SHA256', async () => {
    const { aws, bucketName } = requireSuite();
    const workingDirectory = await createAgentWorkingDirectory('checksummed');
    await syncUp(
      workingDirectory,
      'checksummed',
      '--additional-checksum-algorithm',
      'SHA256',
    );

    expect(await keysUnder('checksummed')).toEqual(everyFile);
    for (const relativePath of everyFile) {
      const content = await readFile(
        join(workingDirectory.hostPath, relativePath),
      );
      expect(
        await readStoredSha256(
          aws.s3,
          bucketName,
          `${prefixFor('checksummed')}${relativePath}`,
        ),
        relativePath,
      ).toBe(sha256Base64(content));
    }
  });
});
