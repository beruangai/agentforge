import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type KeptCopy,
  recordKeptCopy,
  removeForeignKeptCopies,
  removeKeptCopy,
} from './kept-copies.ts';

describe('kept copies', () => {
  let root: string;
  let markers: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentforge-kept-'));
    markers = join(root, 'markers');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function keep(localPath: string, overrides: Partial<KeptCopy> = {}) {
    const privateState = `${localPath}.private`;
    const kept: KeptCopy = {
      localPath,
      kind: 'GitFilesystem',
      store: 'file:///repo',
      remotePath: '/vault',
      runtimeSessionId: 'r-1',
      paths: [localPath, privateState],
      ...overrides,
    };
    await mkdir(localPath, { recursive: true });
    await mkdir(privateState, { recursive: true });
    await recordKeptCopy(kept, markers);
    return kept;
  }

  it('keeps a copy whose identity matches in full', async () => {
    const kept = await keep(join(root, 'vault'));
    await removeForeignKeptCopies(kept, markers);
    expect(existsSync(kept.localPath)).toBe(true);
    expect(await readdir(markers)).toHaveLength(1);
  });

  it.each<[string, Partial<KeptCopy>]>([
    ['runtime session', { runtimeSessionId: 'r-2' }],
    ['kind', { kind: 'S3Filesystem' }],
    ['store', { store: 'file:///other' }],
    ['remote path', { remotePath: '/elsewhere' }],
  ])(
    'removes a copy of another %s, with its private paths and marker',
    async (_label, other) => {
      const kept = await keep(join(root, 'vault'));
      await removeForeignKeptCopies({ ...kept, ...other }, markers);
      for (const path of kept.paths) expect(existsSync(path)).toBe(false);
      expect(await readdir(markers)).toEqual([]);
    },
  );

  it('removes a copy around or inside the directory, and no other', async () => {
    const outer = await keep(join(root, 'vault'));
    const sibling = await keep(join(root, 'other'));
    await removeForeignKeptCopies(
      { ...outer, localPath: join(root, 'vault', 'topics') },
      markers,
    );
    expect(existsSync(outer.localPath)).toBe(false);
    expect(existsSync(sibling.localPath)).toBe(true);
    const inner = await keep(join(root, 'other', 'topics'));
    await removeForeignKeptCopies(sibling, markers);
    expect(existsSync(inner.localPath)).toBe(false);
    expect(existsSync(sibling.localPath)).toBe(true);
  });

  it('removes a copy and its marker', async () => {
    const kept = await keep(join(root, 'vault'));
    await removeKeptCopy(kept, markers);
    for (const path of kept.paths) expect(existsSync(path)).toBe(false);
    expect(await readdir(markers)).toEqual([]);
  });

  it('refuses to record an incomplete identity', async () => {
    await expect(
      recordKeptCopy(
        { localPath: join(root, 'vault'), paths: [] } as unknown as KeptCopy,
        markers,
      ),
    ).rejects.toThrow();
  });
});
