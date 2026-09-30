import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsdown';
import {
  BUNDLE_DIRECTORY,
  pluginEntries,
  publishedManifest,
  publishedPluginManifests,
} from './published-manifest.ts';

/**
 * One package, seven entry points and the Nx plugin's implementations. Code shared between entry points is split
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
    'temporal/workflow': 'src/client/temporal/workflow/index.ts',
    agent: 'src/server/harness/index.ts',
    server: 'src/server/runtime/index.ts',
    infra: 'src/infra/index.ts',
    ...(await pluginEntries()),
  },
  format: 'esm',
  deps: { onlyBundle: [] },
  platform: 'node',
  tsconfig: 'tsconfig.lib.json',
  dts: true,
  sourcemap: true,
  outDir: BUNDLE_DIRECTORY,
  clean: true,
  fixedExtension: false,
  copy: [
    'README.md',
    'Dockerfile',
    // The construct's readiness probe, a Lambda asset beside `infra.js`.
    {
      from: 'src/infra/readiness-probe/index.mjs',
      to: `${BUNDLE_DIRECTORY}/readiness-probe`,
    },
    // The container's collector configuration, beside `server.js`.
    {
      from: 'src/server/runtime/collector/*.yaml',
      to: `${BUNDLE_DIRECTORY}/collector`,
    },
    // The container workspace's root manifest and lock, which `container-lock` writes.
    {
      from: [
        'container/workspace/package.json',
        'container/workspace/bun.lock',
      ],
      to: `${BUNDLE_DIRECTORY}/container`,
    },
    // The shared local Temporal server's compose project, beside its executor.
    {
      from: 'src/plugin/executors/temporal-server/compose/**',
      to: BUNDLE_DIRECTORY,
      flatten: false,
    },
    // The plugin's option schemas, beside the implementations its manifests name.
    {
      from: 'src/plugin/**/schema.json',
      to: BUNDLE_DIRECTORY,
      flatten: false,
    },
  ],
  hooks: {
    'build:done': writePublishedManifests,
  },
});

/** The published `package.json` and the plugin's manifests, derived from the source. */
async function writePublishedManifests(): Promise<void> {
  const written = {
    'package.json': await publishedManifest(),
    ...(await publishedPluginManifests()),
  };
  for (const [path, manifest] of Object.entries(written)) {
    const file = join(BUNDLE_DIRECTORY, path);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
