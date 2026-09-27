import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskContext } from '../task-process.ts';
import { ScriptedFilesystem } from './__fixtures__/scripted-filesystem.ts';
import { type Ending, FilesystemUnsynced } from './filesystem.ts';

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
    const path = join(root, 'vault');
    const filesystem = new ScriptedFilesystem({
      path,
      scope: ({ input }) => ({
        root: `topics/${(input as { topic: string }).topic}/`,
        write: ['notes/today.md'],
      }),
    });
    const vault = await mount(filesystem);
    expect(filesystem.calls).toEqual(['pull topics/today']);
    expect(existsSync(join(path, 'pulled.md'))).toBe(true);
    expect(vault.mounted).toEqual({
      path,
      permissions: {
        allow: [`Read(/${path}/**)`, `Edit(/${path}/notes/today.md)`],
      },
    });
  });

  it('gives a read-only filesystem no write scope', async () => {
    const path = join(root, 'vault');
    const vault = await mount(
      new ScriptedFilesystem({ path, access: 'READ_ONLY', push: 'NEVER' }),
    );
    expect(vault.mounted.permissions.allow).toEqual([`Read(/${path}/**)`]);
  });

  it.each<[string, Ending, boolean]>([
    ['WHEN_COMPLETED', 'COMPLETED', true],
    ['WHEN_COMPLETED', 'FAILED', false],
    ['WHEN_ENDED', 'FAILED', true],
    ['WHEN_ENDED', 'CANCELED', false],
    ['NEVER', 'COMPLETED', false],
  ])(
    'pushes %s when the task ends %s: %s; and removes the mount',
    async (push, ending, pushes) => {
      const path = join(root, 'vault');
      const filesystem = new ScriptedFilesystem({
        path,
        push: push as 'NEVER',
      });
      await (await mount(filesystem)).unmount(ending);
      expect(filesystem.calls).toEqual(pushes ? ['pull ', 'push '] : ['pull ']);
      expect(existsSync(path)).toBe(false);
    },
  );

  it('fails unsynced when its store fails, and removes what it mounted', async () => {
    const path = join(root, 'vault');
    const unsynced = () => Promise.reject(new FilesystemUnsynced('refused'));
    await expect(
      mount(new ScriptedFilesystem({ path }, { pull: unsynced })),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'FILESYSTEM_UNSYNCED',
        message: 'filesystem "vault" could not be pulled: refused',
      },
    });
    expect(existsSync(path)).toBe(false);
    const vault = await mount(
      new ScriptedFilesystem({ path }, { push: unsynced }),
    );
    await expect(vault.unmount('COMPLETED')).rejects.toMatchObject({
      taskCause: { code: 'FILESYSTEM_UNSYNCED' },
    });
    expect(existsSync(path)).toBe(false);
  });

  it('pushes checkpoints of what has settled while mounted, and stops at unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const filesystem = new ScriptedFilesystem({
      path: join(root, 'vault'),
      push: 'WHEN_ENDED',
      checkpoints: { everySeconds: 5, settleSeconds: 60 },
    });
    const vault = await mount(filesystem);
    await vi.advanceTimersByTimeAsync(5_000);
    await vault.unmount('COMPLETED');
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
          path: join(root, 'x'),
          checkpoints: { everySeconds: 5, settleSeconds: 0 },
        }),
    ).toThrow(/need `push: "WHEN_ENDED"`/);
    expect(
      () =>
        new ScriptedFilesystem({ path: join(root, 'x'), access: 'READ_ONLY' }),
    ).toThrow(/a read-only filesystem never pushes/);
    expect(() => new ScriptedFilesystem({ path: 'relative' })).toThrow(
      /absolute path/,
    );
    expect(() => new ScriptedFilesystem({})).toThrow(
      /ScriptedFilesystem needs a path/,
    );
    await expect(
      mount(
        new ScriptedFilesystem({
          path: join(root, 'x'),
          scope: () => ({ root: 'a/../b' }),
        }),
      ),
    ).rejects.toThrow(/never climbs/);
    await expect(
      mount(
        new ScriptedFilesystem({
          path: join(root, 'x'),
          access: 'READ_ONLY',
          push: 'NEVER',
          scope: () => ({ root: '', write: ['**'] }),
        }),
      ),
    ).rejects.toThrow(/is read-only/);
  });
});
