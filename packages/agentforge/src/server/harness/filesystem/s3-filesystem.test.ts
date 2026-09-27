import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TaskContext } from '../task-process.ts';
import {
  S3Filesystem,
  type S3FilesystemOptions,
  type S7cmdResult,
} from './s3-filesystem.ts';
import { ScratchFilesystem } from './scratch-filesystem.ts';

const CLIMBING = '(?:(^|/)\\.\\.(/|$))';

let path: string;
beforeEach(async () => {
  path = join(await mkdtemp(join(tmpdir(), 'agentforge-s3-')), 'vault');
});

/** An S3 filesystem over a scripted `s7cmd`, with the bucket `vault` declared. */
function s3(
  options: Partial<S3FilesystemOptions> = {},
  exits: S7cmdResult[] = [],
) {
  const calls: (readonly string[])[] = [];
  const filesystem = new S3Filesystem(
    {
      path,
      bucket: 'vault',
      access: 'READ_WRITE',
      scope: () => ({ root: 'topics/a' }),
      push: 'WHEN_COMPLETED',
      checkpoints: false,
      deletes: false,
      exclude: [],
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
  it('pulls its root, and pushes by ETag, deleting only when declared', async () => {
    const { calls, mount } = s3({ deletes: true, exclude: ['^cache/'] });
    await (await mount()).unmount('COMPLETED');
    const exclude = `${CLIMBING}|(?:^cache/)`;
    expect(calls).toEqual([
      [
        'sync',
        '--filter-exclude-regex',
        exclude,
        's3://vault-bucket/topics/a/',
        `${path}/`,
      ],
      [
        'sync',
        '--filter-exclude-regex',
        exclude,
        '--check-etag',
        '--delete',
        `${path}/`,
        's3://vault-bucket/topics/a/',
      ],
    ]);
  });

  it('pushes only within its write scope', async () => {
    const { calls, mount } = s3({
      scope: () => ({ root: '', write: ['notes/today.md', 'drafts/**'] }),
    });
    await (await mount()).unmount('COMPLETED');
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
    await expect(refused).rejects.toThrow(/check `exclude`: bad regex/);
    await expect(refused).rejects.not.toHaveProperty('taskCause');
  });

  it('refuses a delete on the whole bucket and an undeclared bucket before anything runs', async () => {
    const whole = s3({ deletes: true, scope: () => ({ root: '' }) });
    await expect(whole.mount()).rejects.toThrow(/deletes needs a root/);
    const undeclared = s3({ bucket: 'other' });
    await expect(undeclared.mount()).rejects.toThrow(
      /no bucket "other" is declared to this agent; declared: vault/,
    );
    expect([...whole.calls, ...undeclared.calls]).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });
});

describe('ScratchFilesystem', () => {
  it('mounts an empty directory of the task’s own, removed when the task ends', async () => {
    const scratch = await new ScratchFilesystem().mount({
      name: 'scratch',
      taskId: 't-1',
      request: { input: {}, context: {} as TaskContext },
    });
    expect(scratch.mounted.path).toBe(
      join(tmpdir(), 'agentforge-scratch', 't-1', 'scratch'),
    );
    expect(existsSync(scratch.mounted.path)).toBe(true);
    await scratch.unmount('COMPLETED');
    expect(existsSync(scratch.mounted.path)).toBe(false);
  });
});
