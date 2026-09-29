import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * What the published package is made of, derived from the source: the
 * manifest a consumer installs, and the Nx plugin's manifests pointing at the
 * bundle's JavaScript. `bundle` writes them; `container-lock` uses the
 * published manifest as the container workspace's `agentforge` member before
 * any bundle exists, so neither task waits on the other's output.
 */
const PACKAGE_ROOT = import.meta.dirname;

/**
 * The published package is assembled under the workspace's one output root,
 * `dist/libs/agentforge/bundle/` — named for the task that builds it —, so the
 * source directory stays clean and everything built sits beside everything
 * else produced.
 */
export const BUNDLE_DIRECTORY = join(
  PACKAGE_ROOT,
  '../../dist/libs/agentforge/bundle',
);

/** The source manifest names the plugin's manifests under `src/`; the bundle holds them under `plugin/`. */
const PLUGIN_SOURCE_DIRECTORY = 'src/plugin';
const PLUGIN_BUNDLE_DIRECTORY = 'plugin';
const PLUGIN_MANIFESTS = ['generators', 'executors'] as const;

type Manifest = Record<string, unknown>;

async function readJson(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8')) as Manifest;
}

/**
 * The published `package.json`: the source manifest without what only the
 * workspace uses. A dependency a consumer installs must carry a real version,
 * and `catalog:` and `workspace:` resolve only inside this workspace, so one
 * reaching the published manifest fails the build rather than a consumer's
 * install.
 */
export async function publishedManifest(): Promise<Manifest> {
  const {
    devDependencies: _workspaceOnly,
    imports: _sourceOnly,
    ...manifest
  } = await readJson(join(PACKAGE_ROOT, 'package.json'));
  manifest.exports = withoutSourceCondition(manifest.exports);
  for (const field of PLUGIN_MANIFESTS) {
    const expected = `./${PLUGIN_SOURCE_DIRECTORY}/${field}.json`;
    if (manifest[field] !== expected) {
      throw new Error(
        `package.json ${field} is ${JSON.stringify(manifest[field])}, expected "${expected}"`,
      );
    }
    manifest[field] = `./${PLUGIN_BUNDLE_DIRECTORY}/${field}.json`;
  }
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
  return manifest;
}

/**
 * `@beruangai/source` resolves an entry point to its TypeScript source inside
 * this workspace. A consumer only ever sees the built files.
 */
function withoutSourceCondition(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '@beruangai/source')
      .map(([key, child]) => [key, withoutSourceCondition(child)]),
  );
}

/** The fields of a generator or executor naming its code, a path relative to its manifest. */
const IMPLEMENTATION_FIELDS = ['factory', 'implementation'] as const;

/** Each implementation a plugin manifest names, relative to the manifest, without its extension. */
function implementationsOf(manifest: Manifest): string[] {
  return Object.values(manifest).flatMap((entries) =>
    Object.values((entries ?? {}) as Record<string, Manifest>).flatMap(
      (entry) =>
        IMPLEMENTATION_FIELDS.flatMap((field) => {
          const path = entry[field];
          if (path === undefined) return [];
          if (typeof path !== 'string' || !/^\.\/.+\.ts$/.test(path)) {
            throw new Error(
              `a plugin ${field} must be a relative .ts path, not ${JSON.stringify(path)}`,
            );
          }
          return [path.slice(2, -'.ts'.length)];
        }),
    ),
  );
}

/**
 * The plugin's manifests as published, keyed by their path in the bundle:
 * every implementation's `.ts` becomes the `.js` the bundle builds from it.
 */
export async function publishedPluginManifests(): Promise<
  Record<string, Manifest>
> {
  const published: Record<string, Manifest> = {};
  for (const field of PLUGIN_MANIFESTS) {
    const source = await readJson(
      join(PACKAGE_ROOT, PLUGIN_SOURCE_DIRECTORY, `${field}.json`),
    );
    published[`${PLUGIN_BUNDLE_DIRECTORY}/${field}.json`] = JSON.parse(
      JSON.stringify(source, (key, value: unknown) =>
        (IMPLEMENTATION_FIELDS as readonly string[]).includes(key) &&
        typeof value === 'string'
          ? value.replace(/\.ts$/, '.js')
          : value,
      ),
    ) as Manifest;
  }
  return published;
}

/** The bundle's entry for each plugin implementation, named for its path under `plugin/`. */
export async function pluginEntries(): Promise<Record<string, string>> {
  const entries: Record<string, string> = {};
  for (const field of PLUGIN_MANIFESTS) {
    const manifest = await readJson(
      join(PACKAGE_ROOT, PLUGIN_SOURCE_DIRECTORY, `${field}.json`),
    );
    for (const implementation of implementationsOf(manifest)) {
      entries[`${PLUGIN_BUNDLE_DIRECTORY}/${implementation}`] =
        `${PLUGIN_SOURCE_DIRECTORY}/${implementation}.ts`;
    }
  }
  return entries;
}
