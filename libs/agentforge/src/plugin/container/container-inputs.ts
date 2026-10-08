import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { workspaceRoot } from '@nx/devkit';

/**
 * What the AgentForge image is built from, all inside AgentForge's own
 * package: the published bundle (the image's build context, which becomes the
 * container workspace's `agentforge` member), its Dockerfile, and the
 * container workspace's root manifest and lock under `container/`.
 */
export interface ContainerInputs {
  /** The build context, and the `agentforge` member's directory. */
  readonly packageDirectory: string;
  readonly dockerfile: string;
  /** The `container` build context: the root manifest and its lock. */
  readonly containerDirectory: string;
  readonly rootManifest: string;
  readonly rootLock: string;
  /** AgentForge's version, which tags its image. */
  readonly version: string;
}

const PACKAGE_NAME = '@beruangai/agentforge';
/**
 * Running from source, in AgentForge's own repository, the published package
 * is the `bundle` task's output, relative to the package's source directory
 * as `tsdown.config.ts` writes it.
 */
const BUNDLE_FROM_SOURCE = '../../dist/libs/agentforge/bundle';

/** The directory of the nearest `package.json` naming AgentForge, from a directory inside it. */
function packageDirectoryAbove(directory: string): string {
  for (let current = directory; ; current = dirname(current)) {
    const manifest = join(current, 'package.json');
    if (
      existsSync(manifest) &&
      (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: unknown })
        .name === PACKAGE_NAME
    ) {
      return current;
    }
    if (dirname(current) === current) {
      throw new Error(`no ${PACKAGE_NAME} package.json above ${directory}`);
    }
  }
}

/** Whether this code is AgentForge's source, in its own repository, rather than the installed package. */
const runningFromSource = import.meta.filename.endsWith('.ts');

/**
 * Requires an installed AgentForge to live inside the workspace running it. A
 * package linked in from elsewhere resolves its peers from where it really
 * lives, not from the workspace, so the two would hold separate copies of
 * each peer, or the package would find none.
 */
export function requireInstalledInside(
  packageDirectory: string,
  workspaceDirectory: string,
): void {
  const installed = realpathSync(packageDirectory);
  const fromWorkspace = relative(realpathSync(workspaceDirectory), installed);
  if (fromWorkspace.startsWith('..') || isAbsolute(fromWorkspace)) {
    throw new Error(
      `${PACKAGE_NAME} is installed as a link to ${installed}, so its peers would resolve from there, not from this workspace. Install the archive instead: bun add ${PACKAGE_NAME}@<path to beruangai-agentforge.tgz>, which AgentForge's pack target writes`,
    );
  }
}

/** The directory of the AgentForge running this code: its source, or the installed package, which must be inside the workspace. */
function runningPackageDirectory(): string {
  const directory = packageDirectoryAbove(import.meta.dirname);
  if (!runningFromSource) {
    requireInstalledInside(directory, workspaceRoot);
  }
  return directory;
}

/**
 * The container inputs of the AgentForge package at `packageDirectory`:
 * the package itself when installed, its `bundle` output when running from
 * source. Throws naming each path it expected and did not find.
 */
export function containerInputsOf(
  packageDirectory: string,
  fromSource: boolean,
): ContainerInputs {
  const published = fromSource
    ? join(packageDirectory, BUNDLE_FROM_SOURCE)
    : packageDirectory;
  const inputs = {
    packageDirectory: published,
    dockerfile: join(published, 'Dockerfile'),
    containerDirectory: join(published, 'container'),
    rootManifest: join(published, 'container', 'package.json'),
    rootLock: join(published, 'container', 'bun.lock'),
  };
  const manifest = join(published, 'package.json');
  const missing = [
    manifest,
    inputs.dockerfile,
    inputs.rootManifest,
    inputs.rootLock,
  ].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(
      `AgentForge's container inputs are missing: ${missing.join(', ')}${
        fromSource
          ? ` (running from source, they are @beruangai/agentforge's bundle output)`
          : ''
      }`,
    );
  }
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as {
    version?: unknown;
  };
  if (typeof version !== 'string') {
    throw new Error(`${manifest} declares no version`);
  }
  return { ...inputs, version };
}

/** What the generators read from AgentForge's own manifest. */
export interface AgentforgeManifest {
  readonly name: string;
  readonly version: string;
  readonly peerDependencies: Readonly<Record<string, string>>;
}

/** The manifest of the AgentForge running this code, source or installed. */
export function agentforgeManifest(): AgentforgeManifest {
  const manifest = join(runningPackageDirectory(), 'package.json');
  const { name, version, peerDependencies } = JSON.parse(
    readFileSync(manifest, 'utf8'),
  ) as Partial<AgentforgeManifest>;
  if (
    typeof name !== 'string' ||
    typeof version !== 'string' ||
    typeof peerDependencies !== 'object'
  ) {
    throw new Error(`${manifest} lacks a name, version or peerDependencies`);
  }
  return { name, version, peerDependencies };
}

/**
 * The container inputs of the AgentForge running this code. Only this module
 * knows whether that is the installed package or its source; nothing a
 * generator writes names either.
 */
export function agentforgeContainerInputs(): ContainerInputs {
  return containerInputsOf(runningPackageDirectory(), runningFromSource);
}
