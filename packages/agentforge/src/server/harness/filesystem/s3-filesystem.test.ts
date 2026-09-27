import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskContext } from '../task-process.ts';
import {
  S3Filesystem,
  type S3FilesystemOptions,
  type S7cmdResult,
} from './s3-filesystem.ts';
import { ScratchFilesystem } from './scratch-filesystem.ts';

let localPath: string;
beforeEach(async () => {
  localPath = join(await mkdtemp(join(tmpdir(), 'agentforge-s3-')), 'vault');
});
afterEach(() => {
  vi.useRealTimers();
});

/** An S3 filesystem over a scripted `s7cmd`, with the bucket `vault` declared. */
function s3(
  options: Partial<S3FilesystemOptions> = {},
  exits: S7cmdResult[] = [],
) {
  const calls: (readonly string[])[] = [];
  const filesystem = new S3Filesystem(
    {
      localPath,
      bucket: 'vault',
      scope: () => ({ remotePath: 'topics/a' }),
      push: 'FULFILLED',
      ...options,
    },
    {
      s7cmd: async (args) => {
        calls.push(args);
        return exits.shift() ?? { exitCode: 0, stderr: '' };
      },
      environment: {
        AGENTFORGE_FILESYSTEM_BUCKETS: JSON.stringify({
          vault: 'vault-bucket',
        }),
      },
    },
  );
  const mount = () =>
    filesystem.mount({
      name: 'vault',
      taskId: 't-1',
      request: { input: {}, context: {} as TaskContext },
    });
  return { calls, mount };
}

describe('S3Filesystem', () => {
  it('pulls its remote path, and pushes by ETag, deleting only when enabled', async () => {
    const { calls, mount } = s3({
      dangerouslyEnableDeletes: true,
      exclude: ['cache/**'],
    });
    await (await mount()).unmount('FULFILLED');
    const exclude = expect.stringMatching(/^\(\?:\(\^\|\/\)/);
    expect(calls).toEqual([
      [
        'sync',
        '--filter-exclude-regex',
        exclude,
        's3://vault-bucket/topics/a/',
        `${localPath}/`,
      ],
      [
        'sync',
        '--filter-exclude-regex',
        exclude,
        '--check-etag',
        '--delete',
        `${localPath}/`,
        's3://vault-bucket/topics/a/',
      ],
    ]);
  });

  it('excludes by glob relative to the mount, and always a climbing path', async () => {
    const { calls, mount } = s3({ exclude: ['cache/**', '**/*.tmp'] });
    await mount();
    const exclude = new RegExp(calls[0]?.[2] ?? '');
    for (const excluded of ['cache/a.bin', 'deep/x.tmp', 'x.tmp', '../up.md']) {
      expect(exclude.test(excluded), excluded).toBe(true);
    }
    for (const kept of ['notes.md', 'a/cache/b.bin', 'x.tmp.md']) {
      expect(exclude.test(kept), kept).toBe(false);
    }
  });

  it('deletes only when dangerously enabled, and never on a checkpoint', async () => {
    const off = s3();
    await (await off.mount()).unmount('FULFILLED');
    expect(off.calls[1]).not.toContain('--delete');

    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const on = s3({
      dangerouslyEnableDeletes: true,
      push: 'SETTLED',
      checkpoints: { intervalSeconds: 5, settleSeconds: 60 },
    });
    const vault = await on.mount();
    await vi.advanceTimersByTimeAsync(5_000);
    await vault.unmount('FULFILLED');
    const [, checkpoint, final] = on.calls;
    expect(checkpoint).toContain('--filter-mtime-before');
    expect(checkpoint).not.toContain('--delete');
    expect(final).toContain('--delete');
  });

  it('pushes only within its write scope', async () => {
    const { calls, mount } = s3({
      scope: () => ({
        remotePath: '',
        write: ['notes/today.md', 'drafts/**'],
      }),
    });
    await (await mount()).unmount('FULFILLED');
    const exclude = new RegExp(calls[1]?.[2] ?? '');
    for (const inside of ['notes/today.md', 'drafts/a.md', 'drafts/x/.b.md']) {
      expect(exclude.test(inside), inside).toBe(false);
    }
    for (const outside of [
      'notes/tomorrow.md',
      'notes/today.md.bak',
      'a/notes/today.md',
      'draftsy.md',
    ]) {
      expect(exclude.test(outside), outside).toBe(true);
    }
    expect(calls[1]?.at(-1)).toBe('s3://vault-bucket/');
  });

  it('fails unsynced on any exit but 0, and as the procedure’s error on refused arguments', async () => {
    await expect(
      s3({}, [{ exitCode: 3, stderr: 'ETag mismatch' }]).mount(),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'FILESYSTEM_UNSYNCED',
        message:
          'filesystem "vault" could not be pulled: s7cmd exited 3: ETag mismatch',
      },
    });
    const refused = s3({}, [{ exitCode: 2, stderr: 'bad regex' }]).mount();
    await expect(refused).rejects.toThrow(
      /s7cmd refused its arguments: bad regex/,
    );
    await expect(refused).rejects.not.toHaveProperty('taskCause');
  });

  it('refuses a delete on the whole bucket and an undeclared bucket before anything runs', async () => {
    const whole = s3({
      dangerouslyEnableDeletes: true,
      scope: () => ({ remotePath: '' }),
    });
    await expect(whole.mount()).rejects.toThrow(
      /dangerouslyEnableDeletes needs a remotePath/,
    );
    const undeclared = s3({ bucket: 'other' });
    await expect(undeclared.mount()).rejects.toThrow(
      /no bucket "other" is declared to this agent; declared: vault/,
    );
    expect([...whole.calls, ...undeclared.calls]).toEqual([]);
    expect(existsSync(localPath)).toBe(false);
  });
});

describe('ScratchFilesystem', () => {
  it('mounts an empty directory of the task’s own, removed when the task ends', async () => {
    const scratch = await new ScratchFilesystem().mount({
      name: 'scratch',
      taskId: 't-1',
      request: { input: {}, context: {} as TaskContext },
    });
    expect(scratch.mounted.localPath).toBe(
      join(tmpdir(), 'agentforge-scratch', 't-1', 'scratch'),
    );
    expect(existsSync(scratch.mounted.localPath)).toBe(true);
    await scratch.unmount('FULFILLED');
    expect(existsSync(scratch.mounted.localPath)).toBe(false);
  });
});
