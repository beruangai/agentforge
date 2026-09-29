import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * Locks one image layer of the container's `/workspace`: recreates the
 * workspace as the layer's image will hold it — the root manifest, then each
 * member's `package.json` at its container path — seeds it with the parent
 * layer's lock, and has Bun resolve. Bun keeps every version the seed already
 * pins and resolves only what the layer adds, so the result is the whole
 * workspace's lock up to this layer, which the layer's image installs frozen.
 *
 *   bun workspace-lock.ts --root <package.json> --member <path>=<dir> …
 *     [--seed <bun.lock>] --out <bun.lock>
 */
const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    member: { type: 'string', multiple: true },
    seed: { type: 'string' },
    out: { type: 'string' },
  },
  strict: true,
});
const { root, seed, out } = values;
if (root === undefined || out === undefined) {
  throw new Error('--root and --out are required');
}

const workspace = await mkdtemp(join(tmpdir(), 'agentforge-workspace-lock-'));
try {
  await copyFile(root, join(workspace, 'package.json'));
  for (const member of values.member ?? []) {
    const [containerPath, directory] = member.split('=');
    if (!containerPath || !directory) {
      throw new Error(
        `--member must be <container path>=<directory>, not "${member}"`,
      );
    }
    await mkdir(join(workspace, containerPath), { recursive: true });
    await copyFile(
      join(directory, 'package.json'),
      join(workspace, containerPath, 'package.json'),
    );
  }
  if (seed !== undefined) await copyFile(seed, join(workspace, 'bun.lock'));
  execFileSync('bun', ['install', '--lockfile-only'], {
    cwd: workspace,
    stdio: 'inherit',
  });
  await copyFile(join(workspace, 'bun.lock'), resolve(out));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
