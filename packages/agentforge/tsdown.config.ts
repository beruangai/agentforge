import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';

/**
 * The published package is assembled under the workspace's one output root,
 * `dist/packages/agentforge/package/`, so the source directory stays clean
 * and everything built sits beside everything else produced.
 */
const packageDirectory = '../../dist/packages/agentforge/package';

/**
 * One package, five entry points. Code shared between entry points is split
 * into common chunks rather than duplicated into each, and every dependency
 * stays external — only this repository's own source is bundled. The syntax
 * target comes from `engines.node`, the one place Node 26 is declared.
 */
export default defineConfig({
  entry: {
    contract: 'src/core/contract/index.ts',
    client: 'src/client/index.ts',
    temporal: 'src/client/temporal/index.ts',
    agent: 'src/server/harness/index.ts',
    infra: 'src/infra/index.ts',
  },
  format: 'esm',
  platform: 'node',
  tsconfig: 'tsconfig.lib.json',
  dts: true,
  sourcemap: true,
  outDir: packageDirectory,
  clean: true,
  fixedExtension: false,
  copy: ['README.md'],
  hooks: {
    'build:done': writePublishedManifest,
  },
});

/**
 * The published `package.json` is the source manifest without what only the
 * workspace uses. A dependency a consumer installs must carry a real version,
 * and `catalog:` and `workspace:` resolve only inside this workspace, so one
 * reaching the published manifest fails the build rather than a consumer's
 * install. There is none yet; how they resolve is decided with the first.
 */
async function writePublishedManifest(): Promise<void> {
  const { devDependencies: _workspaceOnly, ...manifest } = JSON.parse(
    await readFile('package.json', 'utf8'),
  ) as Record<string, unknown>;
  for (const field of [
    'dependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const unresolved = Object.entries(
      (manifest[field] ?? {}) as Record<string, string>,
    ).filter(([, specifier]) => /^(catalog|workspace):/.test(specifier));
    if (unresolved.length > 0) {
      throw new Error(
        `package.json ${field} would publish workspace-only specifiers: ${unresolved
          .map(([name, specifier]) => `${name}@${specifier}`)
          .join(', ')}`,
      );
    }
  }
  await writeFile(
    join(packageDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}
