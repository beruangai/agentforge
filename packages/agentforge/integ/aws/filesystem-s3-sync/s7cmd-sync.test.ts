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
import type { MountLifecycle } from '../../../src/server/harness/filesystem/filesystem.ts';
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
const OPTIONS: Omit<S3FilesystemOptions, 'localPath'> = {
  bucket: 'vault',
  scope: () => ({ remotePath: 'p' }),
  push: 'FULFILLED',
  dangerouslyEnableDeletes: true,
  // `cache/**` holds only if s7cmd matches paths relative to the remote path.
  exclude: ['cache/**', '**/*.tmp'],
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
): Promise<MountLifecycle> {
  const filesystem = new S3Filesystem(
    { ...OPTIONS, localPath: join(root, taskId), ...options },
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
    const { localPath } = vault.mounted;
    expect(await readFile(join(localPath, 'keep.md'), 'utf8')).toBe('keep');
    expect(existsSync(join(localPath, 'cache'))).toBe(false);
    expect(existsSync(join(localPath, '..', 'escape.md'))).toBe(false);

    await writeFile(join(localPath, 'notes.md'), 'new');
    await rm(join(localPath, 'gone.md'));
    await mkdir(join(localPath, 'deep'));
    await writeFile(join(localPath, 'deep', 'added.md'), 'added');
    await writeFile(join(localPath, 'scratch.tmp'), 'excluded locally');
    await delay(1_100); // so a re-upload would move LastModified
    await vault.unmount('FULFILLED');

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
      scope: () => ({ remotePath: 'w', write: ['notes/today.md'] }),
    });
    const { localPath } = vault.mounted;
    await mkdir(join(localPath, 'notes'));
    await writeFile(join(localPath, 'notes', 'today.md'), 'today');
    await writeFile(join(localPath, 'notes', 'tomorrow.md'), 'kept local');
    await rm(join(localPath, 'outside.md'));
    await vault.unmount('FULFILLED');
    expect(await listRelativeKeys(s3, bucket, 'w/')).toEqual([
      'notes/today.md',
      'outside.md',
    ]);
  });

  it('pushes checkpoints, leaving a file that has not settled; a cancel pushes nothing more', async () => {
    const vault = await mount('checkpoints', {
      scope: () => ({ remotePath: 'c' }),
      dangerouslyEnableDeletes: false,
      push: 'SETTLED',
      checkpoints: { intervalSeconds: 5, settleSeconds: 3_600 },
    });
    const { localPath } = vault.mounted;
    await writeFile(join(localPath, 'settled.md'), 'settled');
    const longAgo = new Date('2026-01-01T00:00:00Z');
    await utimes(join(localPath, 'settled.md'), longAgo, longAgo);
    await writeFile(join(localPath, 'fresh.md'), 'fresh');
    await delay(12_000);
    await vault.unmount('CANCELED');
    expect(await listRelativeKeys(s3, bucket, 'c/')).toEqual(['settled.md']);
  });

  it('fails unsynced when the object store refuses', async () => {
    const refused = new S3Filesystem(
      { ...OPTIONS, localPath: join(root, 'refused') },
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
});
