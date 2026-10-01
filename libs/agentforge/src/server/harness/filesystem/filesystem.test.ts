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

async function mount(filesystem: ScriptedFilesystem, name = 'vault') {
  return filesystem.mount(
    filesystem.resolve({
      name,
      taskId: 't-1',
      request: { input: { topic: 'today' }, context: {} as TaskContext },
    }),
  );
}

describe('Filesystem', () => {
  it('pulls the scope the request resolves, and gives baseline permissions for its scopes', async () => {
    const localRoot = join(root, 'vault');
    const localPath = join(localRoot, 'topics', 'today');
    const filesystem = new ScriptedFilesystem({
      localRoot,
      remoteRoot: '/projects/alpha/',
      pushOn: ['TASK_STATE_COMPLETED'],
      scope: ({ input }) => ({
        subpath: `topics/${(input as { topic: string }).topic}/`,
        write: ['notes/today.md'],
      }),
    });
    const vault = await mount(filesystem);
    expect(filesystem.calls).toEqual(['pull /projects/alpha/topics/today']);
    expect(existsSync(join(localPath, 'pulled.md'))).toBe(true);
    expect(vault.mounted).toMatchObject({
      localPath,
      permissions: {
        allow: [`Read(/${localPath}/**)`, `Edit(/${localPath}/notes/today.md)`],
      },
    });
  });

  it.each<[string, string | undefined, string, string, string]>([
    [
      'a remote root and a subpath',
      '/projects/alpha',
      'topics/x/',
      'topics/x',
      '/projects/alpha/topics/x',
    ],
    ['no remote root', undefined, 'topics/x', 'topics/x', '/topics/x'],
    [
      'an empty subpath under a remote root',
      '/projects/alpha/',
      '',
      '',
      '/projects/alpha',
    ],
    ['an empty subpath and no remote root', undefined, '', '', '/'],
  ])(
    'composes its roots and subpath with %s',
    (_label, remoteRoot, subpath, localSubpath, remotePath) => {
      const localRoot = join(root, 'vault');
      const filesystem = new ScriptedFilesystem({
        localRoot: `${localRoot}/`,
        ...(remoteRoot === undefined ? {} : { remoteRoot }),
        scope: () => ({ subpath }),
      });
      expect(
        filesystem.resolve({
          name: 'vault',
          taskId: 't-1',
          request: { input: {}, context: {} as TaskContext },
        }),
      ).toMatchObject({
        localPath:
          localSubpath === '' ? localRoot : join(localRoot, localSubpath),
        remotePath,
      });
    },
  );

  it.each([
    ['projects/alpha', /a remote root is absolute within its store/],
    ['/projects/../alpha', /a remote root has no "." or ".." segment/],
  ])('refuses the remote root %s at construction', (remoteRoot, message) => {
    expect(
      () => new ScriptedFilesystem({ localRoot: join(root, 'x'), remoteRoot }),
    ).toThrow(message);
  });

  it.each(['/topics/x', '../x', 'topics/./x'])(
    'refuses the subpath %s before mounting anything',
    async (subpath) => {
      const localRoot = join(root, 'vault');
      const filesystem = new ScriptedFilesystem({
        localRoot,
        scope: () => ({ subpath }),
      });
      await expect(mount(filesystem)).rejects.toThrow(/never climbs/);
      expect(filesystem.calls).toEqual([]);
      expect(existsSync(localRoot)).toBe(false);
    },
  );

  describe('paths inside the mount', () => {
    async function mounted(write: readonly string[]) {
      const filesystem = new ScriptedFilesystem({
        localRoot: join(root, 'vault'),
        pushOn: ['TASK_STATE_COMPLETED'],
        scope: () => ({ subpath: 'topics/today', write }),
      });
      return (await mount(filesystem)).mounted;
    }

    it('resolves a path inside the mount', async () => {
      const vault = await mounted(['**']);
      expect(vault.path('notes/today.md')).toBe(
        join(root, 'vault', 'topics/today', 'notes/today.md'),
      );
      expect(vault.path('notes/../index.md')).toBe(
        join(root, 'vault', 'topics/today', 'index.md'),
      );
    });

    it.each(['../other/secret.md', '/etc/passwd', 'notes/../../out.md', '..'])(
      'refuses %s, naming the path and the mount',
      async (relativePath) => {
        const vault = await mounted(['**']);
        expect(() => vault.path(relativePath)).toThrow(
          `"${relativePath}" is not a path inside its mount at ${join(root, 'vault', 'topics/today')}`,
        );
        expect(() => vault.writablePath(relativePath)).toThrow(
          /is not a path inside its mount/,
        );
      },
    );

    it.each<[string, readonly string[]]>([
      ['notes/a/b.md', ['**']],
      ['notes/a/b.md', ['notes/**']],
      ['notes/today.md', ['notes/today.md']],
    ])('resolves %s for writing under %j', async (relativePath, write) => {
      const vault = await mounted(write);
      expect(vault.writablePath(relativePath)).toBe(
        join(root, 'vault', 'topics/today', relativePath),
      );
    });

    it('refuses a write outside the write scope, naming the scope', async () => {
      const vault = await mounted(['notes/**']);
      expect(() => vault.writablePath('index.md')).toThrow(
        '"index.md" is outside its write scope (notes/**)',
      );
      expect(vault.path('index.md')).toBe(
        join(root, 'vault', 'topics/today', 'index.md'),
      );
    });
  });

  it('writes nothing by default when it never pushes', async () => {
    const localPath = join(root, 'vault');
    const vault = await mount(new ScriptedFilesystem({ localRoot: localPath }));
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
        localRoot: localPath,
        ...(pushOn === undefined ? {} : { pushOn }),
      });
      await (await mount(filesystem)).unmount(state);
      expect(filesystem.calls).toEqual(
        pushes ? ['pull /', 'push /'] : ['pull /'],
      );
      expect(existsSync(localPath)).toBe(false);
    },
  );

  it('fails unsynced when its store fails, and removes what it mounted', async () => {
    const localPath = join(root, 'vault');
    const unsynced = () => Promise.reject(new FilesystemUnsynced('refused'));
    await expect(
      mount(
        new ScriptedFilesystem({ localRoot: localPath }, { pull: unsynced }),
      ),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'FILESYSTEM_UNSYNCED',
        message: 'filesystem "vault" could not be pulled: refused',
      },
    });
    expect(existsSync(localPath)).toBe(false);
    const vault = await mount(
      new ScriptedFilesystem(
        { localRoot: localPath, pushOn: ['TASK_STATE_COMPLETED'] },
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
      localRoot: join(root, 'vault'),
      pushOn: ['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED'],
      checkpoints: { intervalSeconds: 5, settleSeconds: 60 },
    });
    const vault = await mount(filesystem);
    await vi.advanceTimersByTimeAsync(5_000);
    await vault.unmount('TASK_STATE_COMPLETED');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(filesystem.calls).toEqual([
      'pull /',
      'checkpoint 2026-09-26T23:59:05.000Z',
      'push /',
    ]);
  });

  it('skips a checkpoint while the last is still pushing', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-09-27T00:00:00Z'));
    const { promise: slowStore, resolve: answer } =
      Promise.withResolvers<void>();
    const filesystem = new ScriptedFilesystem(
      {
        localRoot: join(root, 'vault'),
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
      'pull /',
      'checkpoint 2026-09-27T00:00:05.000Z',
      'push /',
    ]);
  });

  it('refuses what it cannot honour', async () => {
    expect(
      () =>
        new ScriptedFilesystem({
          localRoot: join(root, 'x'),
          pushOn: ['TASK_STATE_COMPLETED'],
          checkpoints: { intervalSeconds: 5, settleSeconds: 0 },
        }),
    ).toThrow(/need `pushOn` to include "TASK_STATE_FAILED"/);
    expect(
      () => new ScriptedFilesystem({ localRoot: join(root, 'x'), pushOn: [] }),
    ).toThrow(/pushOn/);
    expect(() => new ScriptedFilesystem({ localRoot: 'relative' })).toThrow(
      /a local root is an absolute directory/,
    );
    expect(
      () =>
        new ScriptedFilesystem({
          localRoot: join(root, 'x'),
          pushon: ['TASK_STATE_COMPLETED'],
        } as Partial<FilesystemOptions>),
    ).toThrow(/Unrecognized key: "pushon"/);
    expect(() => new ScriptedFilesystem({})).toThrow(
      /ScriptedFilesystem needs a localRoot/,
    );
    await expect(
      mount(
        new ScriptedFilesystem({
          localRoot: join(root, 'x'),
          scope: () => ({ subpath: 'a/../b' }),
        }),
      ),
    ).rejects.toThrow(/never climbs/);
    await expect(
      mount(
        new ScriptedFilesystem({
          localRoot: join(root, 'x'),
          pushOn: ['TASK_STATE_COMPLETED'],
          scope: () => ({ subpath: '', write: [] }),
        }),
      ),
    ).rejects.toThrow(/pushes, but its scope writes nothing/);
  });
});
