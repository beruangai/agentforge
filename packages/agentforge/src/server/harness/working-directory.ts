import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, relative, sep } from 'node:path';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { cause } from '#core/contract/task.ts';
import {
  WORKING_DIRECTORIES_VARIABLE,
  WORKING_DIRECTORY_NAME_PATTERN,
} from '#core/working-directory.ts';
import { TaskFailure } from './kernel.ts';

/**
 * How a working directory syncs, declared whole by the consumer — an
 * agentic layer's defaults spread into a procedure's own — with no default
 * of AgentForge's (ADR 0015).
 */
export const WorkingDirectorySyncSchema = z.strictObject({
  /** Download the prefix before the procedure uses it. */
  pull: z.boolean(),
  /**
   * When the task's files go back, verified before the outcome is published:
   * never; only when the task completes; or whenever it ends, completed or
   * failed. Never after a cancel.
   */
  push: z.enum(['NEVER', 'WHEN_COMPLETED', 'WHEN_ENDED']),
  /** Also push while the task runs, so a lost container loses little; only with `WHEN_ENDED`. */
  continuous: z.union([
    z.literal(false),
    z.strictObject({ everySeconds: z.number().int().min(5) }),
  ]),
  /** Whether a push deletes objects under the prefix that the task removed. */
  deletes: z.boolean(),
  /** Globs, relative to the prefix, never pulled or pushed. */
  exclude: z.array(z.string().min(1)),
});
export type WorkingDirectorySync = z.infer<typeof WorkingDirectorySyncSchema>;

export const WorkingDirectorySpecSchema = z.strictObject({
  /** The working directory the construct declared to this agent. */
  name: z.string().regex(WORKING_DIRECTORY_NAME_PATTERN),
  /**
   * The part of it this task works in — `entities/acme`, or `''` for all of
   * it. The procedure chooses it (§REQ401).
   */
  prefix: z
    .string()
    .refine(
      (prefix) =>
        !prefix.startsWith('/') &&
        !prefix
          .split('/')
          .some((segment) => segment === '..' || segment === '.'),
      'a prefix is relative, and never climbs',
    ),
  sync: WorkingDirectorySyncSchema.refine(
    (sync) => sync.continuous === false || sync.push === 'WHEN_ENDED',
    'a continuous push publishes files before the outcome is known: it needs `push: "WHEN_ENDED"`',
  ),
});
export type WorkingDirectorySpec = z.infer<typeof WorkingDirectorySpecSchema>;

export interface OpenWorkingDirectory {
  /** The local directory holding the prefix: add it to the run's `additionalDirectories`. */
  readonly path: string;
}

type Ending = 'COMPLETED' | 'FAILED' | 'CANCELED';

export interface WorkingDirectoriesOptions {
  /** The bucket behind each declared working directory, by name. */
  readonly buckets: Readonly<Record<string, string>>;
  /** A test seam: the S3 client. */
  readonly client?: () => S3Client;
  /** Where tasks' local copies go, one directory per task; the system's temporary directory by default. */
  readonly root?: string;
}

/** The buckets the construct declared, by name; none locally. */
export function declaredWorkingDirectories(
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const declared = environment[WORKING_DIRECTORIES_VARIABLE];
  if (declared === undefined || declared === '') return {};
  return z
    .record(z.string().regex(WORKING_DIRECTORY_NAME_PATTERN), z.string().min(3))
    .parse(JSON.parse(declared));
}

/**
 * The working directories one task opened. Each is a prefix of a bucket,
 * pulled into a directory of the task's own and pushed back as its strategy
 * says; the sync runs in the task's process, so a cancel takes it (ADR 0011).
 */
export class TaskWorkingDirectories {
  readonly #root: string;
  readonly #buckets: Readonly<Record<string, string>>;
  readonly #client: () => S3Client;
  readonly #open = new Map<string, OpenDirectory>();

  constructor(
    options: WorkingDirectoriesOptions & { readonly taskId: string },
  ) {
    this.#root = join(
      options.root ?? join(tmpdir(), 'agentforge-working'),
      options.taskId,
    );
    this.#buckets = options.buckets;
    let client: S3Client | undefined;
    this.#client =
      options.client ??
      (() => {
        client ??= new S3Client({});
        return client;
      });
  }

  async open(declared: WorkingDirectorySpec): Promise<OpenWorkingDirectory> {
    const spec = WorkingDirectorySpecSchema.parse(declared);
    const bucket = this.#buckets[spec.name];
    if (bucket === undefined) {
      throw new Error(
        `no working directory "${spec.name}" is declared to this agent; declared: ${Object.keys(this.#buckets).join(', ') || 'none'}`,
      );
    }
    if (this.#open.has(spec.name)) {
      throw new Error(
        `working directory "${spec.name}" is already open in this task`,
      );
    }
    const directory = new OpenDirectory(
      new PrefixSync({
        client: this.#client(),
        bucket,
        prefix: normalizedPrefix(spec.prefix),
        path: join(this.#root, spec.name),
        exclude: spec.sync.exclude,
      }),
      spec,
    );
    this.#open.set(spec.name, directory);
    await directory.start();
    return { path: directory.path };
  }

  /**
   * Stops continuous pushes, then pushes and verifies each directory whose
   * strategy covers how the task ended. Throws a `WORKING_DIRECTORY_UNSYNCED`
   * failure naming every directory that did not sync.
   */
  async close(ending: Ending): Promise<void> {
    const failures: string[] = [];
    for (const directory of this.#open.values()) {
      try {
        await directory.close(ending);
      } catch (error) {
        failures.push(
          `${directory.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new TaskFailure(
        cause(
          'WORKING_DIRECTORY_UNSYNCED',
          `the working directory did not sync: ${failures.join('; ')}`,
        ),
      );
    }
  }

  /** Removes the task's local copies. */
  async dispose(): Promise<void> {
    await rm(this.#root, { recursive: true, force: true });
  }
}

class OpenDirectory {
  readonly #sync: PrefixSync;
  readonly #spec: WorkingDirectorySpec;
  #continuous: ReturnType<typeof setInterval> | undefined;
  /** Pushes run one at a time: a continuous push never overlaps the last. */
  #pushing: Promise<void> = Promise.resolve();

  constructor(sync: PrefixSync, spec: WorkingDirectorySpec) {
    this.#sync = sync;
    this.#spec = spec;
  }

  get name(): string {
    return this.#spec.name;
  }

  get path(): string {
    return this.#sync.path;
  }

  async start(): Promise<void> {
    await mkdir(this.path, { recursive: true });
    if (this.#spec.sync.pull) {
      try {
        await this.#sync.pull();
      } catch (error) {
        throw new TaskFailure(
          cause(
            'WORKING_DIRECTORY_UNSYNCED',
            `working directory "${this.name}" could not be pulled: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    }
    const { continuous } = this.#spec.sync;
    if (continuous !== false) {
      this.#continuous = setInterval(() => {
        this.#push().catch((error: unknown) => {
          // The push at the end is the one the outcome waits on.
          console.error(
            `working directory "${this.name}": a continuous push failed`,
            error,
          );
        });
      }, continuous.everySeconds * 1000);
    }
  }

  async close(ending: Ending): Promise<void> {
    clearInterval(this.#continuous);
    await this.#pushing.catch(() => undefined);
    const { push } = this.#spec.sync;
    const pushes =
      (push === 'WHEN_COMPLETED' && ending === 'COMPLETED') ||
      (push === 'WHEN_ENDED' && ending !== 'CANCELED');
    if (pushes) await this.#push();
  }

  #push(): Promise<void> {
    this.#pushing = this.#pushing
      .catch(() => undefined)
      .then(() => this.#sync.push({ deletes: this.#spec.sync.deletes }));
    return this.#pushing;
  }
}

/**
 * One bucket prefix against one local directory. An object's ETag is its
 * MD5 — true of every single-part upload to an S3-managed-encryption bucket,
 * which the `WorkingDirectory` construct makes — so a file whose MD5 matches
 * is already there, and a push is verified by listing again.
 */
export class PrefixSync {
  readonly path: string;
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #exclude: readonly string[];

  constructor(options: {
    readonly client: S3Client;
    readonly bucket: string;
    readonly prefix: string;
    readonly path: string;
    readonly exclude: readonly string[];
  }) {
    this.#client = options.client;
    this.#bucket = options.bucket;
    this.#prefix = options.prefix;
    this.path = options.path;
    this.#exclude = options.exclude;
  }

  async pull(): Promise<void> {
    for (const name of (await this.#remote()).keys()) {
      const object = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#prefix + name,
        }),
      );
      if (object.Body === undefined) {
        throw new Error(
          `s3://${this.#bucket}/${this.#prefix}${name} has no body`,
        );
      }
      const file = join(this.path, ...name.split('/'));
      if (relative(this.path, file).split(sep).includes('..')) {
        throw new Error(
          `s3://${this.#bucket}/${this.#prefix}${name} would be written outside the working directory`,
        );
      }
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, await object.Body.transformToByteArray());
    }
  }

  async push(options: { readonly deletes: boolean }): Promise<void> {
    const local = await this.#local();
    const remote = await this.#remote();
    for (const [name, md5] of local) {
      if (remote.get(name) === md5) continue;
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: this.#prefix + name,
          Body: await readFile(join(this.path, ...name.split('/'))),
          ContentMD5: Buffer.from(md5, 'hex').toString('base64'),
        }),
      );
    }
    if (options.deletes) {
      const gone = [...remote.keys()].filter((name) => !local.has(name));
      for (let index = 0; index < gone.length; index += 1000) {
        const result = await this.#client.send(
          new DeleteObjectsCommand({
            Bucket: this.#bucket,
            Delete: {
              Objects: gone
                .slice(index, index + 1000)
                .map((name) => ({ Key: this.#prefix + name })),
              Quiet: true,
            },
          }),
        );
        if (result.Errors?.length) {
          throw new Error(
            `${result.Errors.length} objects could not be deleted: ${result.Errors.map((error) => `${error.Key}: ${error.Code}`).join(', ')}`,
          );
        }
      }
    }
    await this.#verify(local, options);
  }

  async #verify(
    local: ReadonlyMap<string, string>,
    options: { readonly deletes: boolean },
  ): Promise<void> {
    const remote = await this.#remote();
    const differing = [...local]
      .filter(([name, md5]) => remote.get(name) !== md5)
      .map(([name]) => name);
    const extra = options.deletes
      ? [...remote.keys()].filter((name) => !local.has(name))
      : [];
    if (differing.length > 0 || extra.length > 0) {
      throw new Error(
        `after the push, s3://${this.#bucket}/${this.#prefix} ${[
          differing.length > 0 ? `differs at ${differing.join(', ')}` : '',
          extra.length > 0 ? `still holds ${extra.join(', ')}` : '',
        ]
          .filter(Boolean)
          .join(' and ')}`,
      );
    }
  }

  /** Every file under the directory, by its name relative to it, with its MD5. */
  async #local(): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const entry of await readdir(this.path, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (entry.isDirectory()) continue;
      const file = join(entry.parentPath, entry.name);
      const name = relative(this.path, file).split(sep).join('/');
      if (this.#excluded(name)) continue;
      if (!entry.isFile()) {
        throw new Error(
          `${name} is neither a file nor a directory, so it cannot be pushed; exclude it or remove it`,
        );
      }
      files.set(
        name,
        createHash('md5')
          .update(await readFile(file))
          .digest('hex'),
      );
    }
    return files;
  }

  /** Every object under the prefix, by its name relative to it, with its ETag. */
  async #remote(): Promise<Map<string, string>> {
    const objects = new Map<string, string>();
    let continuationToken: string | undefined;
    do {
      const page = await this.#client.send(
        new ListObjectsV2Command({
          Bucket: this.#bucket,
          Prefix: this.#prefix,
          ...(continuationToken === undefined
            ? {}
            : { ContinuationToken: continuationToken }),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key === undefined || object.Key.endsWith('/')) continue;
        const name = object.Key.slice(this.#prefix.length);
        if (this.#excluded(name)) continue;
        objects.set(name, (object.ETag ?? '').replaceAll('"', ''));
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken !== undefined);
    return objects;
  }

  #excluded(name: string): boolean {
    return this.#exclude.some((pattern) => matchesGlob(name, pattern));
  }
}

function normalizedPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}
