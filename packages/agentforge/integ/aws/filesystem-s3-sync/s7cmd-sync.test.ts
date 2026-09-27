/**
 * `S3Filesystem` on `s7cmd`, pinned in the base image, against a real
 * bucket — the harness's own sync, its arguments unchanged, with only where
 * `s7cmd` runs swapped for a container of the base image as built.
 *
 * Kept as a test because `s7cmd` is a personal project whose dependencies are
 * updated best-effort: a new release is admitted by bumping the pin in the
 * Dockerfile and passing this suite (ADR 0015,
 * `docs/research/working-directory-sync.md`).
 *
 * Every check names the full set of keys it expects, so a "kept out" check
 * also proves the rest arrived, and an empty result can never pass.
 */
import { randomUUIDv7 } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MountedHandle } from '../../../src/server/harness/filesystem/filesystem.ts';
import {
  S3Filesystem,
  type S3FilesystemOptions,
  type S7cmdRunner,
} from '../../../src/server/harness/filesystem/s3-filesystem.ts';
import { buildAgentForgeBaseImage } from '../__fixtures__/agentforge-base-image.ts';
import { s7cmdInBaseImage } from './__fixtures__/s7cmd-in-base-image.ts';
import {
  createScratchBucket,
  deleteScratchBucket,
  listRelativeKeys,
} from './__fixtures__/scratch-bucket.ts';

/** Everything but where it mounts, which is per task. */
const OPTIONS: Omit<S3FilesystemOptions, 'path'> = {
  bucket: 'vault',
  access: 'READ_WRITE',
  scope: () => ({ root: 'p' }),
  push: 'WHEN_COMPLETED',
  checkpoints: false,
  deletes: true,
  // Anchored at the start: it holds only if patterns see paths relative to the prefix.
  exclude: ['^cache/', '\\.tmp$'],
};

const s3 = new S3Client({});
let bucket: string;
let root: string;
let s7cmd: S7cmdRunner;
/** What `beforeAll` got as far as creating, for `afterAll` to remove. */
const created: { bucket?: string; root?: string } = {};

async function put(key: string, body: string): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
}

async function body(key: string): Promise<string> {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return (await object.Body?.transformToString()) ?? '';
}

/** Mounts an S3 filesystem for one task, in the directory `s7cmd`'s container shares. */
function mount(
  taskId: string,
  options: Partial<S3FilesystemOptions> = {},
): Promise<MountedHandle> {
  const filesystem = new S3Filesystem(
    { ...OPTIONS, path: join(root, taskId), ...options },
    {
      s7cmd,
      environment: {
        AGENTFORGE_FILESYSTEM_BUCKETS: JSON.stringify({ vault: bucket }),
      },
    },
  );
  // No scope here reads the request.
  return filesystem.mount({
    name: 'vault',
    taskId,
    request: { input: undefined, context: {} as never },
  });
}

beforeAll(async () => {
  await buildAgentForgeBaseImage();
  bucket = await createScratchBucket(s3, randomUUIDv7());
  created.bucket = bucket;
  root = await mkdtemp(join(tmpdir(), 'agentforge-s7cmd-'));
  created.root = root;
  s7cmd = await s7cmdInBaseImage(s3, root);
}, 900_000);

// A setup failure is its own report; teardown removes only what exists.
afterAll(async () => {
  if (created.root !== undefined) {
    await rm(created.root, { recursive: true, force: true });
  }
  if (created.bucket !== undefined) {
    await deleteScratchBucket(s3, created.bucket);
  }
});

describe('S3 filesystems on s7cmd, against a real bucket', () => {
  it('pulls a prefix, and pushes back only what changed, deleting what the task removed and never what it excludes', async () => {
    await put('p/notes.md', 'old');
    await put('p/keep.md', 'keep');
    await put('p/gone.md', 'gone');
    await put('p/cache/remote.bin', 'excluded remotely');
    await put('p/../escape.md', 'climbs');
    await put('other/untouched.md', 'other');
    const keptModified = (
      await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: 'p/keep.md' }))
    ).LastModified;

    const vault = await mount('round-trip');
    const { path } = vault.mounted;
    expect(await readFile(join(path, 'keep.md'), 'utf8')).toBe('keep');
    expect(existsSync(join(path, 'cache'))).toBe(false);
    expect(existsSync(join(path, '..', 'escape.md'))).toBe(false);

    await writeFile(join(path, 'notes.md'), 'new');
    await rm(join(path, 'gone.md'));
    await mkdir(join(path, 'deep'));
    await writeFile(join(path, 'deep', 'added.md'), 'added');
    await writeFile(join(path, 'scratch.tmp'), 'excluded locally');
    await delay(1_100); // so a re-upload would move LastModified
    await vault.unmount('COMPLETED');

    expect(await listRelativeKeys(s3, bucket, 'p/')).toEqual([
      '../escape.md',
      'cache/remote.bin',
      'deep/added.md',
      'keep.md',
      'notes.md',
    ]);
    expect(await body('p/notes.md')).toBe('new');
    expect(await listRelativeKeys(s3, bucket, 'other/')).toEqual([
      'untouched.md',
    ]);
    // --check-etag: what the task did not change is not uploaded again.
    expect(
      (
        await s3.send(
          new HeadObjectCommand({ Bucket: bucket, Key: 'p/keep.md' }),
        )
      ).LastModified,
    ).toEqual(keptModified);
  });

  it('pushes only within its write scope, and deletes nothing outside it', async () => {
    await put('w/outside.md', 'remote');
    const vault = await mount('write-scope', {
      scope: () => ({ root: 'w', write: ['notes/today.md'] }),
    });
    const { path } = vault.mounted;
    await mkdir(join(path, 'notes'));
    await writeFile(join(path, 'notes', 'today.md'), 'today');
    await writeFile(join(path, 'notes', 'tomorrow.md'), 'kept local');
    await rm(join(path, 'outside.md'));
    await vault.unmount('COMPLETED');
    expect(await listRelativeKeys(s3, bucket, 'w/')).toEqual([
      'notes/today.md',
      'outside.md',
    ]);
  });

  it('pushes checkpoints, leaving a file that has not settled; a cancel pushes nothing more', async () => {
    const vault = await mount('checkpoints', {
      scope: () => ({ root: 'c' }),
      deletes: false,
      push: 'WHEN_ENDED',
      checkpoints: { everySeconds: 5, settleSeconds: 3_600 },
    });
    const { path } = vault.mounted;
    await writeFile(join(path, 'settled.md'), 'settled');
    const longAgo = new Date('2026-01-01T00:00:00Z');
    await utimes(join(path, 'settled.md'), longAgo, longAgo);
    await writeFile(join(path, 'fresh.md'), 'fresh');
    await delay(12_000);
    await vault.unmount('CANCELED');
    expect(await listRelativeKeys(s3, bucket, 'c/')).toEqual(['settled.md']);
  });

  it('fails unsynced when the object store refuses', async () => {
    const refused = new S3Filesystem(
      { ...OPTIONS, path: join(root, 'refused') },
      {
        s7cmd,
        environment: {
          AGENTFORGE_FILESYSTEM_BUCKETS: JSON.stringify({
            vault: `${bucket}-absent`,
          }),
        },
      },
    );
    await expect(
      refused.mount({
        name: 'vault',
        taskId: 'refused',
        request: { input: undefined, context: {} as never },
      }),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'FILESYSTEM_UNSYNCED',
        message: expect.stringMatching(
          /could not be pulled: s7cmd exited [13]/,
        ),
      },
    });
  });

  it('fails a pattern s7cmd cannot parse as the procedure’s error', async () => {
    const mounted = mount('bad-pattern', { exclude: ['('] });
    await expect(mounted).rejects.toThrow(/check `exclude`/);
    await expect(mounted).rejects.not.toHaveProperty('taskCause');
  });
});
