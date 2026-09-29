import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The container's `/workspace` is a Bun workspace: AgentForge at `agentforge/`,
 * an agentic project's base layer at `agentic/`, its agent at `agentic/agent/`.
 * Each image layer installs frozen from a lock of the whole workspace up to it.
 */
export interface ContainerWorkspaceMember {
  /** Where the member sits under `/workspace`. */
  readonly containerPath: 'agentforge' | 'agentic' | 'agentic/agent';
  /** Its `package.json`. */
  readonly manifest: string;
}

export interface ContainerWorkspaceLock {
  /** The workspace root's `package.json`. */
  readonly rootManifest: string;
  readonly members: readonly ContainerWorkspaceMember[];
  /** The parent layer's lock, which keeps every version it pinned. */
  readonly seed?: string;
  /** Where the layer's lock is written. */
  readonly out: string;
}

/**
 * Recreates the workspace as the layer's image will hold it — the root
 * manifest, each member's `package.json` at its container path, the parent
 * layer's lock — in `directory`.
 */
export async function assembleContainerWorkspace(
  directory: string,
  lock: Omit<ContainerWorkspaceLock, 'out'>,
): Promise<void> {
  await copyFile(lock.rootManifest, join(directory, 'package.json'));
  for (const member of lock.members) {
    await mkdir(join(directory, member.containerPath), { recursive: true });
    await copyFile(
      member.manifest,
      join(directory, member.containerPath, 'package.json'),
    );
  }
  if (lock.seed !== undefined) {
    await copyFile(lock.seed, join(directory, 'bun.lock'));
  }
}

/**
 * Locks one layer: Bun resolves the recreated workspace, keeping every
 * version the seed pins and resolving only what the layer adds, so the
 * result is the whole workspace's lock up to this layer. Throws, after Bun's
 * own output, when Bun cannot resolve it.
 */
export async function lockContainerWorkspace(
  lock: ContainerWorkspaceLock,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agentforge-workspace-lock-'));
  try {
    await assembleContainerWorkspace(directory, lock);
    const install = spawnSync('bun', ['install', '--lockfile-only'], {
      cwd: directory,
      stdio: 'inherit',
    });
    if (install.error !== undefined) throw install.error;
    if (install.status !== 0) {
      throw new Error(
        `bun install --lockfile-only exited ${install.status ?? install.signal} locking ${lock.out}`,
      );
    }
    await copyFile(join(directory, 'bun.lock'), lock.out);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
