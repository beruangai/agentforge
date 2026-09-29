import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/**
 * The container inputs of the AgentForge running this code. Only this module
 * knows whether that is the installed package or its source; nothing a
 * generator writes names either.
 */
export function agentforgeContainerInputs(): ContainerInputs {
  return containerInputsOf(
    packageDirectoryAbove(import.meta.dirname),
    import.meta.filename.endsWith('.ts'),
  );
}
