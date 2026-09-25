import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The `tarball` task: the bundle packed as npm would publish it, beside the
 * manifest and lockfile the base image installs into Bun's global directory —
 * AgentForge and the peers its `/agent` and `/server` entries import, at the
 * workspace catalog's versions. The directory is the base image's build
 * context.
 */
const WORKSPACE_ROOT = join(import.meta.dirname, '..', '..');
const BUNDLE_DIRECTORY = join(
  WORKSPACE_ROOT,
  'dist/packages/agentforge/bundle',
);
const TARBALL_DIRECTORY = join(
  WORKSPACE_ROOT,
  'dist/packages/agentforge/tarball',
);

/** What the server and the harness import at run time; the client's peers are not. */
const RUNTIME_PEERS = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@a2a-js/sdk',
  '@aws-sdk/client-dynamodb',
  '@orpc/contract',
  '@orpc/server',
  'express',
  'zod',
] as const;

async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, {
    cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if ((await child.exited) !== 0) {
    throw new Error(`${command.join(' ')} failed in ${cwd}`);
  }
}

const workspaceManifest = JSON.parse(
  await readFile(join(WORKSPACE_ROOT, 'package.json'), 'utf8'),
) as { catalog: Record<string, string> };
const bundleManifest = JSON.parse(
  await readFile(join(BUNDLE_DIRECTORY, 'package.json'), 'utf8'),
) as { name: string; peerDependencies: Record<string, string> };

const peers = Object.fromEntries(
  RUNTIME_PEERS.map((name) => {
    if (bundleManifest.peerDependencies[name] === undefined) {
      throw new Error(`${name} is not a peer of ${bundleManifest.name}`);
    }
    const version = workspaceManifest.catalog[name];
    if (version === undefined) {
      throw new Error(`${name} has no version in the workspace catalog`);
    }
    return [name, version];
  }),
);

await rm(TARBALL_DIRECTORY, { recursive: true, force: true });
await mkdir(TARBALL_DIRECTORY, { recursive: true });
await run(
  ['bun', 'pm', 'pack', '--destination', TARBALL_DIRECTORY],
  BUNDLE_DIRECTORY,
);
const [tarball, ...others] = (await readdir(TARBALL_DIRECTORY)).filter((file) =>
  file.endsWith('.tgz'),
);
if (tarball === undefined || others.length > 0) {
  throw new Error(`expected one tarball in ${TARBALL_DIRECTORY}`);
}
await writeFile(
  join(TARBALL_DIRECTORY, 'package.json'),
  `${JSON.stringify(
    {
      name: 'agentforge-global',
      private: true,
      dependencies: { [bundleManifest.name]: `./${tarball}`, ...peers },
    },
    null,
    2,
  )}\n`,
);
await run(['bun', 'install', '--lockfile-only'], TARBALL_DIRECTORY);
