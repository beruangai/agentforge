import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';

/**
 * The published package is assembled under the workspace's one output root,
 * `dist/packages/agentforge/bundle/` — named for the task that builds it —, so the source directory stays clean
 * and everything built sits beside everything else produced.
 */
const bundleDirectory = '../../dist/packages/agentforge/bundle';

/**
 * One package, six entry points. Code shared between entry points is split
 * into common chunks rather than duplicated into each, and every dependency
 * stays external — only this repository's own source is bundled. tsdown
 * externalises only what the manifest declares and inlines anything else with
 * no more than an info line, so `onlyBundle: []` turns an import of an
 * undeclared package into a failed build rather than a copy of it shipped to
 * consumers. The syntax target comes from `engines.node`, the one place Node 26
 * is declared.
 */
export default defineConfig({
  entry: {
    contract: 'src/core/contract/index.ts',
    client: 'src/client/index.ts',
    temporal: 'src/client/temporal/index.ts',
    agent: 'src/server/harness/index.ts',
    server: 'src/server/runtime/index.ts',
    infra: 'src/infra/index.ts',
  },
  format: 'esm',
  deps: { onlyBundle: [] },
  platform: 'node',
  tsconfig: 'tsconfig.lib.json',
  dts: true,
  sourcemap: true,
  outDir: bundleDirectory,
  clean: true,
  fixedExtension: false,
  copy: [
    'README.md',
    'Dockerfile',
    // The construct's readiness probe, a Lambda asset beside `infra.js`.
    {
      from: 'src/infra/readiness-probe/index.mjs',
      to: `${bundleDirectory}/readiness-probe`,
    },
  ],
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
  const {
    devDependencies: _workspaceOnly,
    imports: _sourceOnly,
    ...manifest
  } = JSON.parse(await readFile('package.json', 'utf8')) as Record<
    string,
    unknown
  >;
  manifest.exports = withoutSourceCondition(manifest.exports);
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
    join(bundleDirectory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

/**
 * `@beruangai/source` resolves an entry point to its TypeScript source inside
 * this workspace, where the examples consume AgentForge live. A consumer only
 * ever sees the built files.
 */
function withoutSourceCondition(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '@beruangai/source')
      .map(([key, child]) => [key, withoutSourceCondition(child)]),
  );
}
