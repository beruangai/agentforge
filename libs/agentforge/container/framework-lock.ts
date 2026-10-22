import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameworkNameEnum } from '#core/contract/framework.ts';
import { publishedManifest } from '../published-manifest.ts';
import { frameworkPlugin } from '../src/framework/registry.ts';
import { lockContainerWorkspace } from '../src/plugin/container/container-workspace.ts';

/**
 * The `container-lock-<framework>` task: the container's `/workspace` root as
 * the framework's image installs it. The framework layer extends the base's
 * root rather than joining it as a member: its manifest is the base's root
 * manifest plus the framework's container peers, at the workspace catalog's
 * versions, with the same member globs. Its lock is seeded with the base's, so
 * every version the base resolved holds and only the framework's peers are
 * resolved here. As the base's, the `agentforge` member is the manifest the
 * package publishes, so the lock needs no bundle and the bundle ships it.
 */
const framework = FrameworkNameEnum.parse(process.argv[2]);
const WORKSPACE_ROOT = join(import.meta.dirname, '..', '..', '..');
const BASE_MANIFEST = join(import.meta.dirname, 'workspace', 'package.json');
const BASE_LOCK = join(import.meta.dirname, 'workspace', 'bun.lock');
const CONTAINER = join(
  import.meta.dirname,
  '..',
  'src',
  'framework',
  framework,
  'container',
);
const ROOT_MANIFEST = join(CONTAINER, 'package.json');

const { catalog } = JSON.parse(
  await readFile(join(WORKSPACE_ROOT, 'package.json'), 'utf8'),
) as { catalog: Record<string, string> };
const base = JSON.parse(await readFile(BASE_MANIFEST, 'utf8')) as {
  dependencies: Record<string, string>;
};

const peers = Object.fromEntries(
  frameworkPlugin(framework).containerPeers.map((name) => {
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
      ...base,
      name: `agentforge-${framework}-container`,
      dependencies: { ...base.dependencies, ...peers },
    },
    null,
    2,
  )}\n`,
);
const agentforge = await mkdtemp(join(tmpdir(), 'agentforge-published-'));
try {
  await writeFile(
    join(agentforge, 'package.json'),
    `${JSON.stringify(await publishedManifest(), null, 2)}\n`,
  );
  await lockContainerWorkspace({
    rootManifest: ROOT_MANIFEST,
    members: [
      {
        containerPath: 'agentforge',
        manifest: join(agentforge, 'package.json'),
      },
    ],
    seed: BASE_LOCK,
    out: join(CONTAINER, 'bun.lock'),
  });
} finally {
  await rm(agentforge, { recursive: true, force: true });
}
