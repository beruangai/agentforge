import { createHash } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { isWithin } from './mount-claims.ts';

/** Where the container's kept copies are recorded: beside the claims, never inside a mount. */
export const KEPT_COPIES_DIRECTORY = join(tmpdir(), 'agentforge-kept-copies');

const KeptCopySchema = z.strictObject({
  localPath: z.string(),
  kind: z.string(),
  store: z.string(),
  remotePath: z.string(),
  runtimeSessionId: z.string(),
  /** What removing the copy removes: its local directory, and any state its kind keeps for it. */
  paths: z.array(z.string()),
});
export type KeptCopy = z.infer<typeof KeptCopySchema>;

/** What a kept copy is a copy of, and for which runtime session: a later mount reuses it only when all of it matches. */
export type KeptCopyIdentity = Omit<KeptCopy, 'paths'>;

function markerFile(directory: string, localPath: string): string {
  const digest = createHash('sha256').update(resolve(localPath)).digest('hex');
  return join(directory, `${digest}.json`);
}

/**
 * Removes, with everything each lists, every kept copy at `identity`'s local
 * directory, or around or inside it, that is not this identity in full: a
 * copy never carries to another runtime session, kind, store or remote path.
 * The caller holds the directory's claim, so no live task uses what is removed.
 */
export async function removeForeignKeptCopies(
  identity: KeptCopyIdentity,
  directory: string = KEPT_COPIES_DIRECTORY,
): Promise<void> {
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const localPath = resolve(identity.localPath);
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const entry = join(directory, file);
    let content: string;
    try {
      content = await readFile(entry, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const kept = KeptCopySchema.parse(JSON.parse(content));
    const keptPath = resolve(kept.localPath);
    if (!isWithin(keptPath, localPath) && !isWithin(localPath, keptPath)) {
      continue;
    }
    if (
      keptPath === localPath &&
      kept.kind === identity.kind &&
      kept.store === identity.store &&
      kept.remotePath === identity.remotePath &&
      kept.runtimeSessionId === identity.runtimeSessionId
    ) {
      continue;
    }
    await removeKeptCopy(kept, directory);
  }
}

/** Records the copy at its local directory, replacing what was recorded there. */
export async function recordKeptCopy(
  kept: KeptCopy,
  directory: string = KEPT_COPIES_DIRECTORY,
): Promise<void> {
  const valid = KeptCopySchema.parse(kept);
  await mkdir(directory, { recursive: true });
  const entry = markerFile(directory, valid.localPath);
  // Renamed into place, so a concurrent reader never reads a partial entry.
  await writeFile(`${entry}.tmp`, JSON.stringify(valid));
  await rename(`${entry}.tmp`, entry);
}

/** Removes every path the copy lists, then its record. */
export async function removeKeptCopy(
  kept: Pick<KeptCopy, 'localPath' | 'paths'>,
  directory: string = KEPT_COPIES_DIRECTORY,
): Promise<void> {
  for (const path of kept.paths) {
    await rm(path, { recursive: true, force: true });
  }
  await rm(markerFile(directory, kept.localPath), { force: true });
}
