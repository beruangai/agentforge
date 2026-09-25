import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The `manifest` task: what the agentic base image installs into /agentic —
 * this project's production dependencies, less every package AgentForge's
 * base image already provides, at the workspace catalog's versions — and the
 * lockfile that freezes them. Hand-written here first; the Nx plugin's
 * executor is extracted from it (DESIGN_OPTIONS §K).
 */
const PROJECT_ROOT = import.meta.dirname;
const WORKSPACE_ROOT = join(PROJECT_ROOT, '..', '..');
const BASE_MANIFEST = join(
  WORKSPACE_ROOT,
  'dist/packages/agentforge/tarball/package.json',
);
const MANIFEST_DIRECTORY = join(
  WORKSPACE_ROOT,
  'dist/examples/agentic-project/manifest',
);

interface Manifest {
  readonly name: string;
  readonly imports?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly catalog?: Record<string, string>;
}

async function readManifest(path: string): Promise<Manifest> {
  return JSON.parse(await readFile(path, 'utf8')) as Manifest;
}

const project = await readManifest(join(PROJECT_ROOT, 'package.json'));
const base = await readManifest(BASE_MANIFEST);
const { catalog = {} } = await readManifest(
  join(WORKSPACE_ROOT, 'package.json'),
);
const provided = new Set(Object.keys(base.dependencies ?? {}));

const dependencies: Record<string, string> = {};
for (const [name, specifier] of Object.entries(project.dependencies ?? {})) {
  if (provided.has(name)) continue;
  if (specifier.startsWith('workspace:')) {
    throw new Error(
      `${name} is a workspace package the base image does not provide; an image cannot install it`,
    );
  }
  const version = specifier === 'catalog:' ? catalog[name] : specifier;
  if (version === undefined) {
    throw new Error(`${name} has no version in the workspace catalog`);
  }
  dependencies[name] = version;
}

await rm(MANIFEST_DIRECTORY, { recursive: true, force: true });
await mkdir(MANIFEST_DIRECTORY, { recursive: true });
await writeFile(
  join(MANIFEST_DIRECTORY, 'package.json'),
  `${JSON.stringify(
    {
      name: project.name,
      private: true,
      type: 'module',
      ...(project.imports === undefined ? {} : { imports: project.imports }),
      dependencies,
    },
    null,
    2,
  )}\n`,
);
execFileSync('bun', ['install', '--lockfile-only'], {
  cwd: MANIFEST_DIRECTORY,
  stdio: 'inherit',
});
