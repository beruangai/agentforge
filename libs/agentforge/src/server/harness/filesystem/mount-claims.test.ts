import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskContext } from '../task-process.ts';
import { ScriptedFilesystem } from './__fixtures__/scripted-filesystem.ts';
import { FilesystemUnsynced } from './filesystem.ts';
import { claimLocalDirectory, MOUNT_CLAIMS_DIRECTORY } from './mount-claims.ts';

const HOLDER = join(import.meta.dirname, '__fixtures__', 'claim-and-hold.ts');

let root: string;
let claims: string;
const holders: ChildProcess[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentforge-claims-'));
  claims = join(root, 'claims');
});
afterEach(() => {
  for (const holder of holders.splice(0)) holder.kill();
});

/** Another task's process claiming `localPath`: held until the test ends, or exited without releasing it. */
async function claimInChild(
  localPath: string,
  options: { readonly directory?: string; readonly exit?: boolean } = {},
): Promise<ChildProcess> {
  const holder = spawn(
    'bun',
    [
      HOLDER,
      options.directory ?? claims,
      localPath,
      'held-task',
      options.exit === true ? 'exit' : 'hold',
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  holders.push(holder);
  const [chunk] = (await once(holder.stdout, 'data')) as [Buffer];
  expect(chunk.toString()).toBe('claimed\n');
  if (options.exit === true && holder.exitCode === null) {
    await once(holder, 'exit');
  }
  return holder;
}

const claim = (localPath: string, taskId = 't-1') =>
  claimLocalDirectory({ name: 'vault', taskId, localPath }, claims);

describe('the mount claims', () => {
  it('refuse a mount on a directory a live task holds, unsynced and retryable, leaving its files untouched', async () => {
    const localPath = join(root, 'vault');
    await mkdir(localPath);
    await writeFile(join(localPath, 'holder.md'), 'the holder’s');
    await claimInChild(localPath, { directory: MOUNT_CLAIMS_DIRECTORY });
    const filesystem = new ScriptedFilesystem({ localRoot: localPath });
    await expect(
      filesystem.mount(
        filesystem.resolve({
          name: 'vault',
          taskId: 't-1',
          request: { input: {}, context: {} as TaskContext },
        }),
      ),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'FILESYSTEM_UNSYNCED',
        retryable: true,
        message: expect.stringContaining(
          `filesystem "vault" could not be mounted: ${localPath} overlaps ${localPath}, mounted by task held-task`,
        ),
      },
    });
    expect(filesystem.calls).toEqual([]);
    expect(existsSync(join(localPath, 'holder.md'))).toBe(true);
  });

  it.each([
    ['inside', (held: string) => join(held, 'notes')],
    ['around', (held: string) => join(held, '..')],
  ])('refuse a directory %s a held one', async (_label, near) => {
    const held = join(root, 'vault', 'topics');
    await claimInChild(held);
    await expect(claim(near(held))).rejects.toThrow(FilesystemUnsynced);
    await expect(claim(join(root, 'vault', 'other'))).resolves.toBeTypeOf(
      'function',
    );
  });

  it('clear a claim whose process has exited', async () => {
    const localPath = join(root, 'vault');
    await claimInChild(localPath, { exit: true });
    expect(await readdir(claims)).toHaveLength(1);
    const release = await claim(localPath);
    expect(await readdir(claims)).toEqual([`t-1.vault.${process.pid}.json`]);
    await release();
  });

  it('free a directory once released', async () => {
    const localPath = join(root, 'vault');
    const release = await claim(localPath, 't-1');
    await expect(claim(localPath, 't-2')).rejects.toThrow(
      /mounted by task t-1 as "vault"/,
    );
    await release();
    await expect(claim(localPath, 't-2')).resolves.toBeTypeOf('function');
  });

  it('never grant both of two racing claims', async () => {
    for (let round = 0; round < 50; round += 1) {
      const localPath = join(root, `race-${round}`);
      const results = await Promise.allSettled([
        claim(localPath, 't-1'),
        claim(localPath, 't-2'),
      ]);
      const granted = results.filter((result) => result.status === 'fulfilled');
      expect(granted.length).toBeLessThan(2);
      for (const result of granted) await result.value();
    }
  });
});
