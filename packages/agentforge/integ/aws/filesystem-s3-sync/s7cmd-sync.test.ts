/**
 * Working directories on `s7cmd`, pinned in the base image, against a real
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
import {
  type S7cmdRunner,
  TaskWorkingDirectories,
  type WorkingDirectorySync,
} from '../../../src/server/harness/working-directory.ts';
import { buildAgentForgeBaseImage } from '../__fixtures__/agentforge-base-image.ts';
import { s7cmdInBaseImage } from './__fixtures__/s7cmd-in-base-image.ts';
import {
  createScratchBucket,
  deleteScratchBucket,
  listRelativeKeys,
} from './__fixtures__/scratch-bucket.ts';

const SYNC: WorkingDirectorySync = {
  pull: true,
  push: 'WHEN_COMPLETED',
  continuous: false,
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

function task(taskId: string): TaskWorkingDirectories {
  return new TaskWorkingDirectories({
    taskId,
    buckets: { vault: bucket },
    s7cmd,
    root,
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

describe('working directories on s7cmd, against a real bucket', () => {
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

    const directories = task('round-trip');
    const { path } = await directories.open({
      name: 'vault',
      prefix: 'p',
      sync: SYNC,
    });
    expect(await readFile(join(path, 'keep.md'), 'utf8')).toBe('keep');
    expect(existsSync(join(path, 'cache'))).toBe(false);
    expect(existsSync(join(path, '..', 'escape.md'))).toBe(false);

    await writeFile(join(path, 'notes.md'), 'new');
    await rm(join(path, 'gone.md'));
    await mkdir(join(path, 'deep'));
    await writeFile(join(path, 'deep', 'added.md'), 'added');
    await writeFile(join(path, 'scratch.tmp'), 'excluded locally');
    await delay(1_100); // so a re-upload would move LastModified
    await directories.close('COMPLETED');
    await directories.dispose();

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

  it('pushes continuously, leaving a file changed in the quiet period; a cancel pushes nothing more', async () => {
    const directories = task('continuous');
    const { path } = await directories.open({
      name: 'vault',
      prefix: 'c',
      sync: {
        ...SYNC,
        pull: false,
        deletes: false,
        push: 'WHEN_ENDED',
        continuous: { everySeconds: 5, quietSeconds: 3_600 },
      },
    });
    await writeFile(join(path, 'settled.md'), 'settled');
    const longAgo = new Date('2026-01-01T00:00:00Z');
    await utimes(join(path, 'settled.md'), longAgo, longAgo);
    await writeFile(join(path, 'fresh.md'), 'fresh');
    await delay(12_000);
    await directories.close('CANCELED');
    await directories.dispose();
    expect(await listRelativeKeys(s3, bucket, 'c/')).toEqual(['settled.md']);
  });

  it('fails unsynced when the object store refuses', async () => {
    const directories = new TaskWorkingDirectories({
      taskId: 'refused',
      buckets: { vault: `${bucket}-absent` },
      s7cmd,
      root,
    });
    await expect(
      directories.open({ name: 'vault', prefix: 'p', sync: SYNC }),
    ).rejects.toMatchObject({
      taskCause: {
        code: 'WORKING_DIRECTORY_UNSYNCED',
        message: expect.stringMatching(
          /could not be pulled: s7cmd exited [13]/,
        ),
      },
    });
  });

  it('fails a pattern s7cmd cannot parse as the procedure’s error', async () => {
    const opened = task('bad-pattern').open({
      name: 'vault',
      prefix: 'p',
      sync: { ...SYNC, exclude: ['('] },
    });
    await expect(opened).rejects.toThrow(/check its `exclude` patterns/);
    await expect(opened).rejects.not.toHaveProperty('taskCause');
  });
});
