import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { S3Client } from '@aws-sdk/client-s3';
import { oc } from '@orpc/contract';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { contractHash } from '#core/contract/procedures.ts';
import { executeProcedure, implementAgent } from './task-process.ts';
import {
  declaredWorkingDirectories,
  TaskWorkingDirectories,
  type WorkingDirectorySync,
} from './working-directory.ts';

/** An in-memory bucket whose ETags are MD5s, as an S3-managed-encryption bucket's are. */
function inMemoryS3(options: { dropPuts?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const commands: string[] = [];
  const client = {
    async send(command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) {
      const { input } = command;
      commands.push(command.constructor.name);
      switch (command.constructor.name) {
        case 'ListObjectsV2Command':
          return {
            Contents: [...objects]
              .filter(([key]) => key.startsWith(input.Prefix as string))
              .map(([Key, body]) => ({
                Key,
                ETag: `"${createHash('md5').update(body).digest('hex')}"`,
              })),
          };
        case 'GetObjectCommand': {
          const body = objects.get(input.Key as string);
          return {
            Body: { transformToByteArray: async () => body },
          };
        }
        case 'PutObjectCommand': {
          const body = input.Body as Buffer;
          expect(input.ContentMD5).toBe(
            createHash('md5').update(body).digest('base64'),
          );
          if (!options.dropPuts) objects.set(input.Key as string, body);
          return {};
        }
        case 'DeleteObjectsCommand':
          for (const { Key } of (input.Delete as { Objects: { Key: string }[] })
            .Objects) {
            objects.delete(Key);
          }
          return {};
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  } as unknown as S3Client;
  return { client, objects, commands };
}

const SYNC: WorkingDirectorySync = {
  pull: true,
  push: 'WHEN_COMPLETED',
  continuous: false,
  deletes: true,
  exclude: ['**/*.tmp'],
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentforge-working-test-'));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(root, { recursive: true, force: true });
});

function directories(s3: ReturnType<typeof inMemoryS3>, taskId = 't-1') {
  return new TaskWorkingDirectories({
    taskId,
    buckets: { vault: 'vault-bucket' },
    client: () => s3.client,
    root,
  });
}

describe('TaskWorkingDirectories', () => {
  it('pulls its prefix, and pushes back only what changed, deleting what the task removed', async () => {
    const s3 = inMemoryS3();
    s3.objects.set('entities/acme/notes.md', Buffer.from('old'));
    s3.objects.set('entities/acme/deep/keep.md', Buffer.from('keep'));
    s3.objects.set('entities/acme/gone.md', Buffer.from('gone'));
    s3.objects.set('entities/other/untouched.md', Buffer.from('other'));
    const task = directories(s3);
    const { path } = await task.open({
      name: 'vault',
      prefix: 'entities/acme/',
      sync: SYNC,
    });
    expect(await readFile(join(path, 'deep', 'keep.md'), 'utf8')).toBe('keep');
    expect(existsSync(join(path, '..', 'other'))).toBe(false);

    await writeFile(join(path, 'notes.md'), 'new');
    await rm(join(path, 'gone.md'));
    await writeFile(join(path, 'scratch.tmp'), 'excluded');
    s3.commands.length = 0;
    await task.close('COMPLETED');

    expect(
      Object.fromEntries([...s3.objects].map(([k, v]) => [k, `${v}`])),
    ).toEqual({
      'entities/acme/notes.md': 'new',
      'entities/acme/deep/keep.md': 'keep',
      'entities/other/untouched.md': 'other',
    });
    expect(
      s3.commands.filter((name) => name === 'PutObjectCommand'),
    ).toHaveLength(1);
  });

  it('pushes as its strategy says, and never after a cancel', async () => {
    const cases = [
      ['WHEN_COMPLETED', 'FAILED', false],
      ['WHEN_ENDED', 'FAILED', true],
      ['WHEN_ENDED', 'CANCELED', false],
      ['NEVER', 'COMPLETED', false],
    ] as const;
    for (const [push, ending, pushed] of cases) {
      const s3 = inMemoryS3();
      const task = directories(s3, `${push}-${ending}`);
      const { path } = await task.open({
        name: 'vault',
        prefix: '',
        sync: { ...SYNC, push },
      });
      await writeFile(join(path, 'out.md'), 'x');
      await task.close(ending);
      expect([push, ending, s3.objects.has('out.md')]).toEqual([
        push,
        ending,
        pushed,
      ]);
    }
  });

  it('pushes continuously while the task runs', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const s3 = inMemoryS3();
    const task = directories(s3);
    const { path } = await task.open({
      name: 'vault',
      prefix: 'p',
      sync: { ...SYNC, push: 'WHEN_ENDED', continuous: { everySeconds: 5 } },
    });
    await writeFile(join(path, 'progress.md'), 'half');
    await vi.advanceTimersByTimeAsync(5_000);
    // A cancel pushes nothing, but waits for the push under way.
    await task.close('CANCELED');
    expect(`${s3.objects.get('p/progress.md')}`).toBe('half');
  });

  it('fails unsynced when the bucket does not hold what was pushed', async () => {
    const task = directories(inMemoryS3({ dropPuts: true }));
    const { path } = await task.open({ name: 'vault', prefix: '', sync: SYNC });
    await writeFile(join(path, 'out.md'), 'x');
    await expect(task.close('COMPLETED')).rejects.toMatchObject({
      taskCause: {
        code: 'WORKING_DIRECTORY_UNSYNCED',
        retryable: true,
        message: expect.stringContaining('differs at out.md'),
      },
    });
  });

  it('fails unsynced over what it cannot push, and over a key that would escape', async () => {
    const s3 = inMemoryS3();
    const task = directories(s3);
    const { path } = await task.open({ name: 'vault', prefix: '', sync: SYNC });
    await symlink('/etc/hosts', join(path, 'link'));
    await expect(task.close('COMPLETED')).rejects.toMatchObject({
      taskCause: {
        code: 'WORKING_DIRECTORY_UNSYNCED',
        message: expect.stringContaining('link is neither a file'),
      },
    });

    s3.objects.set('p/../../escape.md', Buffer.from('x'));
    await expect(
      directories(s3, 't-2').open({ name: 'vault', prefix: 'p', sync: SYNC }),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'WORKING_DIRECTORY_UNSYNCED',
        message: expect.stringContaining('outside the working directory'),
      },
    });
  });

  it('refuses what it cannot honour', async () => {
    const task = directories(inMemoryS3());
    await expect(
      task.open({ name: 'nope', prefix: '', sync: SYNC }),
    ).rejects.toThrow(/no working directory "nope".*declared: vault/);
    await expect(
      task.open({ name: 'vault', prefix: 'a/../b', sync: SYNC }),
    ).rejects.toThrow(/never climbs/);
    await expect(
      task.open({
        name: 'vault',
        prefix: '',
        sync: { ...SYNC, continuous: { everySeconds: 30 } },
      }),
    ).rejects.toThrow(/WHEN_ENDED/);
    await task.open({ name: 'vault', prefix: '', sync: SYNC });
    await expect(
      task.open({ name: 'vault', prefix: 'x', sync: SYNC }),
    ).rejects.toThrow(/already open/);
  });
});

describe('declaredWorkingDirectories', () => {
  it('reads the buckets the construct declared, and none locally', () => {
    expect(declaredWorkingDirectories({})).toEqual({});
    expect(
      declaredWorkingDirectories({
        AGENTFORGE_WORKING_DIRECTORIES: '{"vault":"vault-bucket"}',
      }),
    ).toEqual({ vault: 'vault-bucket' });
  });
});

describe('executeProcedure, with a working directory', () => {
  const contract = {
    write: oc.input(z.object({})).output(z.object({ ok: z.boolean() })),
  };
  const os = implementAgent(contract);
  const router = os.router({
    write: os.write.handler(async ({ context }) => {
      const { path } = await context.openWorkingDirectory({
        name: 'vault',
        prefix: 'out',
        sync: SYNC,
      });
      await writeFile(join(path, 'result.md'), 'done');
      return { ok: true };
    }),
  });

  function execute(s3: ReturnType<typeof inMemoryS3>) {
    return executeProcedure({
      contract,
      router,
      invocation: {
        taskId: 't-1',
        contextId: 'c-1',
        runtimeSessionId: 'r-1',
        attempt: 1,
        priorAttempt: undefined,
        envelope: {
          procedure: 'write',
          contractHash: contractHash(contract.write),
          input: {},
          idempotencyKey: 'k-1',
        },
      },
      signal: new AbortController().signal,
      onRecord: () => undefined,
      workingDirectories: {
        buckets: { vault: 'vault-bucket' },
        client: () => s3.client,
        root,
      },
    });
  }

  it('publishes the outcome after the push, and removes its local copy', async () => {
    const s3 = inMemoryS3();
    expect(await execute(s3)).toEqual({
      state: 'TASK_STATE_COMPLETED',
      output: { ok: true },
    });
    expect(`${s3.objects.get('out/result.md')}`).toBe('done');
    expect(existsSync(join(root, 't-1'))).toBe(false);
  });

  it('fails a completed task whose files did not arrive', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await execute(inMemoryS3({ dropPuts: true }))).toMatchObject({
      state: 'TASK_STATE_FAILED',
      cause: { code: 'WORKING_DIRECTORY_UNSYNCED' },
    });
  });
});
