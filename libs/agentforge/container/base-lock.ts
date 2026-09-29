import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishedManifest } from '../published-manifest.ts';
import { lockContainerWorkspace } from '../src/plugin/container/container-workspace.ts';

/**
 * The `container-lock` task: the container's `/workspace` root as the base
 * image installs it. The root manifest declares the workspace — AgentForge at
 * `agentforge/`, an agentic project at `agentic/`, its agent at
 * `agentic/agent/` — and depends on the peers AgentForge's server and harness
 * import, at the workspace catalog's versions. Its lock is seeded with the
 * previous one, so an unchanged manifest keeps every resolved version. The
 * `agentforge` member is the manifest the package publishes, derived from the
 * source, so the lock needs no bundle and the bundle ships the lock.
 */
const WORKSPACE_ROOT = join(import.meta.dirname, '..', '..', '..');
const ROOT_MANIFEST = join(import.meta.dirname, 'workspace', 'package.json');
const ROOT_LOCK = join(import.meta.dirname, 'workspace', 'bun.lock');

/** What the server and the harness import at run time; the client's peers are not. */
const RUNTIME_PEERS = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@a2a-js/sdk',
  '@aws-sdk/client-cloudwatch',
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/client-secrets-manager',
  '@aws-sdk/client-s3',
  '@orpc/contract',
  '@orpc/server',
  'express',
  'zod',
] as const;

const { catalog } = JSON.parse(
  await readFile(join(WORKSPACE_ROOT, 'package.json'), 'utf8'),
) as { catalog: Record<string, string> };
const bundle = (await publishedManifest()) as {
  name: string;
  peerDependencies: Record<string, string>;
};

const dependencies = Object.fromEntries(
  RUNTIME_PEERS.map((name) => {
    if (bundle.peerDependencies[name] === undefined) {
      throw new Error(`${name} is not a peer of ${bundle.name}`);
    }
    const version = catalog[name];
    if (version === undefined) {
      throw new Error(`${name} has no version in the workspace catalog`);
    }
    return [name, version];
  }),
);

await writeFile(
  ROOT_MANIFEST,
  `${JSON.stringify(
    {
      name: 'agentforge-container',
      private: true,
      // Globs, not paths: a path whose directory a lower layer has not
      // created yet is an error ("Workspace not found"), a glob that matches
      // nothing is not. `[c]` and `[t]` keep each an exact match.
      workspaces: ['agentforge', 'agenti[c]', 'agentic/agen[t]'],
      dependencies,
    },
    null,
    2,
  )}\n`,
);
const seed = await access(ROOT_LOCK).then(
  () => ROOT_LOCK,
  () => undefined,
);
const agentforge = await mkdtemp(join(tmpdir(), 'agentforge-published-'));
try {
  await writeFile(
    join(agentforge, 'package.json'),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );
  await lockContainerWorkspace({
    rootManifest: ROOT_MANIFEST,
    members: [
      {
        containerPath: 'agentforge',
        manifest: join(agentforge, 'package.json'),
      },
    ],
    ...(seed === undefined ? {} : { seed }),
    out: ROOT_LOCK,
  });
} finally {
  await rm(agentforge, { recursive: true, force: true });
}
