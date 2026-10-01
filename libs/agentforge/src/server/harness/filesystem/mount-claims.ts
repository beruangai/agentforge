import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { FilesystemUnsynced, type Mount } from './filesystem.ts';

/** Where the container's live mounts are claimed: task processes share nothing else. */
export const MOUNT_CLAIMS_DIRECTORY = join(tmpdir(), 'agentforge-mounts');

const MountClaimSchema = z.strictObject({
  localPath: z.string(),
  taskId: z.string(),
  name: z.string(),
  pid: z.number().int(),
});
type MountClaim = z.infer<typeof MountClaimSchema>;

/**
 * Claims a mount's local directory for its task in this container, before
 * anything is created there: refused with `FilesystemUnsynced`, naming the
 * holder, while another live task holds it or a directory around or inside
 * it. Resolves to the release. The entry is visible before the claims are
 * listed, so of two racing claims the later lister sees the earlier, and
 * never both succeed; at worst both refuse, retryably.
 */
export async function claimLocalDirectory(
  mount: Pick<Mount, 'name' | 'taskId' | 'localPath'>,
  directory: string = MOUNT_CLAIMS_DIRECTORY,
): Promise<() => Promise<void>> {
  const claim: MountClaim = {
    localPath: resolve(mount.localPath),
    taskId: mount.taskId,
    name: mount.name,
    pid: process.pid,
  };
  // The pid keeps a crashed attempt's leftover entry from blocking a retry of the same task.
  const entry = join(
    directory,
    `${claim.taskId}.${claim.name}.${claim.pid}.json`,
  );
  try {
    await mkdir(directory, { recursive: true });
    // Renamed into place, so a concurrent lister never reads a partial entry.
    await writeFile(`${entry}.tmp`, JSON.stringify(claim));
    await rename(`${entry}.tmp`, entry);
  } catch (error) {
    throw new FilesystemUnsynced(
      `its claim on ${claim.localPath} could not be written to ${directory}: ${String(error)}`,
    );
  }
  const release = () => rm(entry, { force: true });
  let holder: MountClaim | undefined;
  try {
    holder = await findOverlappingClaim(directory, entry, claim.localPath);
  } catch (error) {
    await release();
    throw new FilesystemUnsynced(
      `the claims in ${directory} could not be read: ${String(error)}`,
    );
  }
  if (holder !== undefined) {
    await release();
    throw new FilesystemUnsynced(
      `${claim.localPath} overlaps ${holder.localPath}, mounted by task ${holder.taskId} as "${holder.name}" in this container; retry once it ends`,
    );
  }
  return release;
}

/** The first live claim other than `own` on `localPath` or a directory around or inside it; a dead process's claim is removed. */
async function findOverlappingClaim(
  directory: string,
  own: string,
  localPath: string,
): Promise<MountClaim | undefined> {
  for (const file of await readdir(directory)) {
    const entry = join(directory, file);
    if (entry === own || !file.endsWith('.json')) continue;
    let content: string;
    try {
      content = await readFile(entry, 'utf8');
    } catch (error) {
      // Released between the listing and the read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const claim = MountClaimSchema.parse(JSON.parse(content));
    if (!isAlive(claim.pid)) {
      await rm(entry, { force: true });
      continue;
    }
    if (
      isWithin(claim.localPath, localPath) ||
      isWithin(localPath, claim.localPath)
    ) {
      return claim;
    }
  }
  return undefined;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, under another user.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Whether `path` is `directory` or inside it. */
export function isWithin(directory: string, path: string): boolean {
  const fromDirectory = relative(directory, path);
  return (
    fromDirectory === '' ||
    (!isAbsolute(fromDirectory) &&
      fromDirectory !== '..' &&
      !fromDirectory.startsWith('../'))
  );
}
