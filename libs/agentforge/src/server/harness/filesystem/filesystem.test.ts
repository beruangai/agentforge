import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskContext } from '../task-process.ts';
import { ScriptedFilesystem } from './__fixtures__/scripted-filesystem.ts';
import { type FilesystemOptions, FilesystemUnsynced } from './filesystem.ts';

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
      pushOn: ['TASK_STATE_COMPLETED'],
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

  it.each<
    [
      string,
      FilesystemOptions['pushOn'],
      'TASK_STATE_COMPLETED' | 'TASK_STATE_FAILED' | 'TASK_STATE_CANCELED',
      boolean,
    ]
  >([
    ['COMPLETED', ['TASK_STATE_COMPLETED'], 'TASK_STATE_COMPLETED', true],
    ['COMPLETED', ['TASK_STATE_COMPLETED'], 'TASK_STATE_FAILED', false],
    [
      'COMPLETED and FAILED',
      ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'],
      'TASK_STATE_FAILED',
      true,
    ],
    [
      'COMPLETED and FAILED',
      ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'],
      'TASK_STATE_CANCELED',
      false,
    ],
    ['absent', undefined, 'TASK_STATE_COMPLETED', false],
  ])(
    'pushOn %s, the task ends %s: pushes %s; and removes the mount',
    async (_label, pushOn, state, pushes) => {
      const localPath = join(root, 'vault');
      const filesystem = new ScriptedFilesystem({
        localPath,
        ...(pushOn === undefined ? {} : { pushOn }),
      });
      await (await mount(filesystem)).unmount(state);
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
        { localPath, pushOn: ['TASK_STATE_COMPLETED'] },
        { push: unsynced },
      ),
    );
    await expect(vault.unmount('TASK_STATE_COMPLETED')).rejects.toMatchObject({
      taskCause: { code: 'FILESYSTEM_UNSYNCED' },
    });
    expect(existsSync(localPath)).toBe(false);
  });

  it('pushes checkpoints of what has settled while mounted, and stops at unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const filesystem = new ScriptedFilesystem({
      localPath: join(root, 'vault'),
      pushOn: ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'],
      checkpoints: { intervalSeconds: 5, settleSeconds: 60 },
    });
    const vault = await mount(filesystem);
    await vi.advanceTimersByTimeAsync(5_000);
    await vault.unmount('TASK_STATE_COMPLETED');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(filesystem.calls).toEqual([
      'pull ',
      'checkpoint 2026-09-26T23:59:05.000Z',
      'push ',
    ]);
  });

  it('skips a checkpoint while the last is still pushing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const { promise: slowStore, resolve: answer } =
      Promise.withResolvers<void>();
    const filesystem = new ScriptedFilesystem(
      {
        localPath: join(root, 'vault'),
        pushOn: ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'],
        checkpoints: { intervalSeconds: 5, settleSeconds: 0 },
      },
      { push: () => slowStore },
    );
    const vault = await mount(filesystem);
    await vi.advanceTimersByTimeAsync(20_000);
    answer();
    await vault.unmount('TASK_STATE_COMPLETED');
    expect(filesystem.calls).toEqual([
      'pull ',
      'checkpoint 2026-09-27T00:00:05.000Z',
      'push ',
    ]);
  });

  it('refuses what it cannot honour', async () => {
    expect(
      () =>
        new ScriptedFilesystem({
          localPath: join(root, 'x'),
          pushOn: ['TASK_STATE_COMPLETED'],
          checkpoints: { intervalSeconds: 5, settleSeconds: 0 },
        }),
    ).toThrow(/need `pushOn` to include "TASK_STATE_FAILED"/);
    expect(
      () => new ScriptedFilesystem({ localPath: join(root, 'x'), pushOn: [] }),
    ).toThrow(/pushOn/);
    expect(() => new ScriptedFilesystem({ localPath: 'relative' })).toThrow(
      /absolute local path/,
    );
    expect(
      () =>
        new ScriptedFilesystem({
          localPath: join(root, 'x'),
          pushon: ['TASK_STATE_COMPLETED'],
        } as Partial<FilesystemOptions>),
    ).toThrow(/Unrecognized key: "pushon"/);
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
          pushOn: ['TASK_STATE_COMPLETED'],
          scope: () => ({ remotePath: '', write: [] }),
        }),
      ),
    ).rejects.toThrow(/pushes, but its scope writes nothing/);
  });
});
