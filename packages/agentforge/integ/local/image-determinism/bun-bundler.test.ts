/**
 * `bun build` is byte-identical — DESIGN_OPTIONS §D, findings in
 * docs/research/image-determinism.md.
 *
 * The layered-image test copies plain files; nothing in it is bundled, and a
 * bundler is the likelier source of drift in a real agent image — module
 * ordering, chunk hashing and embedded absolute paths are all things one can
 * vary. So this bundles a real server — the AgentCore fixture, with Express,
 * the A2A SDK and AWS SDK clients — and varies, one at a time, what a build
 * pipeline varies:
 *
 *   - the same input in the same place, twice;
 *   - the same input from a DIFFERENT absolute path, so an embedded path shows;
 *   - every source file's mtime changed, so a read of the clock shows;
 *   - `--minify`, twice, the way an image would ship it.
 *
 * And the negative control: a one-line change to the source must move the
 * digest, or none of the comparisons above can fail and they mean nothing.
 *
 * Like the image test, this is kept for auditability, not because anything
 * depends on it: Nx decides what is rebuilt, and AgentForge compares no
 * digests. It is re-measured because the answer is Bun's, and Bun moves.
 */
import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import {
  appendFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommand } from '../../__fixtures__/run-command.ts';

const packageDirectory = join(import.meta.dirname, '..', '..', '..');
const workspaceDirectory = join(packageDirectory, '..', '..');
/** Relative to the package directory, which is where every bundle runs from. */
const serverEntryPoint = join(
  'integ',
  'aws',
  'agentcore',
  '__fixtures__',
  'server.ts',
);
const setupTimeoutMilliseconds = 600_000;
/** Caches written concurrently by other processes, and not bundle inputs. */
const volatileCacheDirectoryNames = new Set(['.vite', '.vite-temp', '.cache']);
const changedModificationTime = new Date('2020-01-01T00:00:00Z');

describe('bun build', () => {
  let scratchDirectory: string | undefined;
  /** The package directory's twin, reached by a different absolute path. */
  let movedPackageDirectory: string | undefined;
  /** Every bundle input outside node_modules, relative to the package directory. */
  let sourceInputs: readonly string[] = [];

  beforeAll(async () => {
    const entryPointPath = join(packageDirectory, serverEntryPoint);
    if (!existsSync(entryPointPath)) {
      throw new Error(
        `The server this test bundles is missing: ${entryPointPath} (the AgentCore integration fixture)`,
      );
    }
    await runCommand('bun', ['--version'], {
      purpose: 'Prerequisite: bun on PATH',
    });
    scratchDirectory = await mkdtemp(
      join(tmpdir(), 'agentforge-integ-bun-bundler-'),
    );

    sourceInputs = await discoverSourceInputs(scratchDirectory);

    // The same workspace layout under a different root: node_modules, the
    // configuration bun reads, and the sources, at the same relative paths —
    // so the relative paths bun writes into its comments are unchanged and
    // only the absolute path differs. Symlinks are copied verbatim; resolving
    // them would point the copy back into the original tree.
    const movedWorkspaceDirectory = join(
      scratchDirectory,
      'moved-to-a-different-absolute-path',
    );
    movedPackageDirectory = join(
      movedWorkspaceDirectory,
      'packages',
      basename(packageDirectory),
    );
    await copyVerbatim(
      join(workspaceDirectory, 'node_modules'),
      join(movedWorkspaceDirectory, 'node_modules'),
    );
    await copyVerbatim(
      join(packageDirectory, 'node_modules'),
      join(movedPackageDirectory, 'node_modules'),
    );
    for (const configurationFile of [
      'package.json',
      'tsconfig.json',
      'tsconfig.base.json',
    ]) {
      await copyVerbatim(
        join(workspaceDirectory, configurationFile),
        join(movedWorkspaceDirectory, configurationFile),
      );
    }
    for (const configurationFile of [
      'package.json',
      'tsconfig.json',
      'tsconfig.lib.json',
      'tsconfig.spec.json',
    ]) {
      await copyVerbatim(
        join(packageDirectory, configurationFile),
        join(movedPackageDirectory, configurationFile),
      );
    }
    for (const sourceInput of sourceInputs) {
      await copyVerbatim(
        join(packageDirectory, sourceInput),
        join(movedPackageDirectory, sourceInput),
      );
    }
  }, setupTimeoutMilliseconds);

  afterAll(async () => {
    if (scratchDirectory !== undefined) {
      await rm(scratchDirectory, { recursive: true });
    }
  }, setupTimeoutMilliseconds);

  function requireScratchDirectory(): string {
    if (scratchDirectory === undefined) {
      throw new Error('The scratch directory was not created; see beforeAll');
    }
    return scratchDirectory;
  }

  function requireMovedPackageDirectory(): string {
    if (movedPackageDirectory === undefined) {
      throw new Error('The moved copy was not created; see beforeAll');
    }
    return movedPackageDirectory;
  }

  let bundleSequence = 0;

  /** Bundles the server from `workingDirectory` and returns the bundle's sha256. */
  async function bundleDigest(
    workingDirectory: string,
    extraFlags: readonly string[] = [],
  ): Promise<string> {
    bundleSequence += 1;
    const outputFile = join(
      requireScratchDirectory(),
      `bundle-${bundleSequence}`,
      'server.js',
    );
    await runCommand(
      'bun',
      [
        'build',
        serverEntryPoint,
        '--target=bun',
        '--outfile',
        outputFile,
        ...extraFlags,
      ],
      {
        purpose: `Bundling the server from ${workingDirectory}`,
        workingDirectory,
      },
    );
    return createHash('sha256')
      .update(await readFile(outputFile))
      .digest('hex');
  }

  /**
   * One bundle with `--metafile`, apart from the compared ones so no compared
   * build carries a flag the others lack. Its inputs outside node_modules are
   * the sources: what the moved copy carries, and whose mtimes are changed.
   */
  async function discoverSourceInputs(
    directory: string,
  ): Promise<readonly string[]> {
    const metafile = join(directory, 'discovery', 'metafile.json');
    await runCommand(
      'bun',
      [
        'build',
        serverEntryPoint,
        '--target=bun',
        '--outfile',
        join(directory, 'discovery', 'server.js'),
        `--metafile=${metafile}`,
      ],
      {
        purpose: 'Discovering the bundle inputs',
        workingDirectory: packageDirectory,
      },
    );
    const { inputs } = JSON.parse(await readFile(metafile, 'utf8')) as {
      inputs: Record<string, unknown>;
    };
    const sources = Object.keys(inputs).filter(
      (input) => !input.split('/').includes('node_modules'),
    );
    for (const source of sources) {
      if (isAbsolute(source) || source.split('/').includes('..')) {
        throw new Error(
          `A bundle input outside node_modules lies outside the package directory, which the moved copy does not reproduce: ${source}`,
        );
      }
    }
    if (!sources.includes(serverEntryPoint.split(sep).join('/'))) {
      throw new Error(
        `The metafile does not list the entry point ${serverEntryPoint} among its inputs: ${JSON.stringify(sources)}`,
      );
    }
    return sources;
  }

  it('is byte-identical built twice from the same place', async () => {
    const first = await bundleDigest(packageDirectory);
    const second = await bundleDigest(packageDirectory);
    expect(second).toBe(first);
  });

  it('is byte-identical built from a different absolute path', async () => {
    const original = await bundleDigest(packageDirectory);
    const moved = await bundleDigest(requireMovedPackageDirectory());
    expect(moved).toBe(original);
  });

  it('is byte-identical after every source mtime changes', async () => {
    const moved = requireMovedPackageDirectory();
    const before = await bundleDigest(moved);
    for (const sourceInput of sourceInputs) {
      await utimes(
        join(moved, sourceInput),
        changedModificationTime,
        changedModificationTime,
      );
    }
    const after = await bundleDigest(moved);
    expect(after).toBe(before);
  });

  it('is byte-identical minified twice', async () => {
    const first = await bundleDigest(packageDirectory, ['--minify']);
    const second = await bundleDigest(packageDirectory, ['--minify']);
    expect(second).toBe(first);
  });

  it('moves when one line of source changes — the control that the comparisons can fail', async () => {
    const moved = requireMovedPackageDirectory();
    const before = await bundleDigest(moved);
    await appendFile(
      join(moved, serverEntryPoint),
      'console.log("a one-line change");\n',
    );
    const after = await bundleDigest(moved);
    expect(after).not.toBe(before);
  });
});

async function copyVerbatim(source: string, destination: string) {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, {
    recursive: true,
    verbatimSymlinks: true,
    // A copy-on-write clone where the filesystem offers one, a copy otherwise:
    // the workspace's node_modules is most of a gigabyte.
    mode: constants.COPYFILE_FICLONE,
    errorOnExist: true,
    force: false,
    filter: (path) => !volatileCacheDirectoryNames.has(basename(path)),
  });
}
