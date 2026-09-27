import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskContext } from '../task-process.ts';
import { ScriptedFilesystem } from './__fixtures__/scripted-filesystem.ts';
import { FilesystemUnsynced, type TaskEnding } from './filesystem.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentforge-filesystem-'));
});
afterEach(() => {
  vi.useRealTimers();
});

function mount(filesystem: ScriptedFilesystem, name = 'vault') {
  return filesystem.mount({
    name,
    taskId: 't-1',
    request: { input: { topic: 'today' }, context: {} as TaskContext },
  });
}

describe('Filesystem', () => {
  it('pulls the scope the request resolves, and gives baseline permissions for its scopes', async () => {
    const localPath = join(root, 'vault');
    const filesystem = new ScriptedFilesystem({
      localPath,
      push: 'FULFILLED',
      scope: ({ input }) => ({
        remotePath: `topics/${(input as { topic: string }).topic}/`,
        write: ['notes/today.md'],
      }),
    });
    const vault = await mount(filesystem);
    expect(filesystem.calls).toEqual(['pull topics/today']);
    expect(existsSync(join(localPath, 'pulled.md'))).toBe(true);
    expect(vault.mounted).toEqual({
      localPath,
      permissions: {
        allow: [`Read(/${localPath}/**)`, `Edit(/${localPath}/notes/today.md)`],
      },
    });
  });

  it('writes nothing by default when it never pushes', async () => {
    const localPath = join(root, 'vault');
    const vault = await mount(new ScriptedFilesystem({ localPath }));
    expect(vault.mounted.permissions.allow).toEqual([`Read(/${localPath}/**)`]);
  });

  it.each<[string, 'FULFILLED' | 'SETTLED' | undefined, TaskEnding, boolean]>([
    ['FULFILLED', 'FULFILLED', 'FULFILLED', true],
    ['FULFILLED', 'FULFILLED', 'REJECTED', false],
    ['SETTLED', 'SETTLED', 'REJECTED', true],
    ['SETTLED', 'SETTLED', 'CANCELED', false],
    ['absent', undefined, 'FULFILLED', false],
  ])(
    'push %s, the task %s: pushes %s; and removes the mount',
    async (_label, push, ending, pushes) => {
      const localPath = join(root, 'vault');
      const filesystem = new ScriptedFilesystem({
        localPath,
        ...(push === undefined ? {} : { push }),
      });
      await (await mount(filesystem)).unmount(ending);
      expect(filesystem.calls).toEqual(pushes ? ['pull ', 'push '] : ['pull ']);
      expect(existsSync(localPath)).toBe(false);
    },
  );

  it('fails unsynced when its store fails, and removes what it mounted', async () => {
    const localPath = join(root, 'vault');
    const unsynced = () => Promise.reject(new FilesystemUnsynced('refused'));
    await expect(
      mount(new ScriptedFilesystem({ localPath }, { pull: unsynced })),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'FILESYSTEM_UNSYNCED',
        message: 'filesystem "vault" could not be pulled: refused',
      },
    });
    expect(existsSync(localPath)).toBe(false);
    const vault = await mount(
      new ScriptedFilesystem(
        { localPath, push: 'FULFILLED' },
        { push: unsynced },
      ),
    );
    await expect(vault.unmount('FULFILLED')).rejects.toMatchObject({
      taskCause: { code: 'FILESYSTEM_UNSYNCED' },
    });
    expect(existsSync(localPath)).toBe(false);
  });

  it('pushes checkpoints of what has settled while mounted, and stops at unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const filesystem = new ScriptedFilesystem({
      localPath: join(root, 'vault'),
      push: 'SETTLED',
      checkpoints: { intervalSeconds: 5, settleSeconds: 60 },
    });
    const vault = await mount(filesystem);
    await vi.advanceTimersByTimeAsync(5_000);
    await vault.unmount('FULFILLED');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(filesystem.calls).toEqual([
      'pull ',
      'checkpoint 2026-09-26T23:59:05.000Z',
      'push ',
    ]);
  });

  it('refuses what it cannot honour', async () => {
    expect(
      () =>
        new ScriptedFilesystem({
          localPath: join(root, 'x'),
          push: 'FULFILLED',
          checkpoints: { intervalSeconds: 5, settleSeconds: 0 },
        }),
    ).toThrow(/need `push: "SETTLED"`/);
    expect(() => new ScriptedFilesystem({ localPath: 'relative' })).toThrow(
      /absolute local path/,
    );
    expect(() => new ScriptedFilesystem({})).toThrow(
      /ScriptedFilesystem needs a localPath/,
    );
    await expect(
      mount(
        new ScriptedFilesystem({
          localPath: join(root, 'x'),
          scope: () => ({ remotePath: 'a/../b' }),
        }),
      ),
    ).rejects.toThrow(/never climbs/);
    await expect(
      mount(
        new ScriptedFilesystem({
          localPath: join(root, 'x'),
          push: 'FULFILLED',
          scope: () => ({ remotePath: '', write: [] }),
        }),
      ),
    ).rejects.toThrow(/pushes, but its scope writes nothing/);
  });
});
