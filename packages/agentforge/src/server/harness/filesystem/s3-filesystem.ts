import { spawn } from 'node:child_process';
import picomatch from 'picomatch';
import { z } from 'zod';
import {
  FILESYSTEM_BUCKETS_VARIABLE,
  FILESYSTEM_NAME_PATTERN,
} from '#core/filesystem.ts';
import {
  Filesystem,
  type FilesystemOptions,
  FilesystemUnsynced,
  type Mount,
} from './filesystem.ts';

export interface S3FilesystemOptions extends FilesystemOptions {
  /** Where it mounts: an S3 filesystem has no default, so prompts can name it. */
  readonly path: string;
  /** The bucket's name as the deployment declared it (`AgentRuntime.filesystems`). */
  readonly bucket: string;
  /** Whether a push deletes the objects the task removed, within the write scope; only on a non-empty root. */
  readonly deletes: boolean;
  /** Regular expressions (`s7cmd`'s syntax) over paths relative to the root: never pulled, pushed or deleted. */
  readonly exclude: readonly string[];
}

/** How one `s7cmd` run ended. */
export interface S7cmdResult {
  readonly exitCode: number;
  /** The end of what it wrote to stderr. */
  readonly stderr: string;
}

export type S7cmdRunner = (args: readonly string[]) => Promise<S7cmdResult>;

/** The base image installs it on the `PATH` (packages/agentforge/Dockerfile). */
const S7CMD = 's7cmd';
/** How much of `s7cmd`'s stderr a failure carries. */
const STDERR_TAIL_CHARACTERS = 2_000;
/** `s7cmd` refused its arguments: a bad `exclude` pattern, or AgentForge's bug. */
const S7CMD_EXIT_INVALID_ARGUMENTS = 2;
/** Excluded always: a key with a `..` segment would be written outside the mount. */
const CLIMBING_PATH_PATTERN = '(^|/)\\.\\.(/|$)';

/** Runs `s7cmd` as a child of the task process, so a cancel or a lost container takes it. */
export const runS7cmd: S7cmdRunner = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(S7CMD, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARACTERS);
    });
    child.on('error', (error: NodeJS.ErrnoException) =>
      reject(
        error.code === 'ENOENT'
          ? new Error(
              `${S7CMD} is not on the PATH: S3 filesystems run in AgentForge's base image, which installs it`,
            )
          : error,
      ),
    );
    child.on('close', (code, signal) =>
      resolve({
        exitCode: code ?? -1,
        stderr: signal === null ? stderr : `${stderr}\nkilled by ${signal}`,
      }),
    );
  });

/**
 * A prefix of an S3 bucket, synced by `s7cmd`, which verifies each object it
 * transfers by ETag. A push compares by ETag, so an unchanged file is not
 * sent again, and never leaves the write scope.
 */
export class S3Filesystem extends Filesystem {
  readonly #s3Options: Pick<
    S3FilesystemOptions,
    'bucket' | 'deletes' | 'exclude'
  >;
  readonly #s7cmd: S7cmdRunner;
  readonly #environment: NodeJS.ProcessEnv;

  constructor(
    options: S3FilesystemOptions,
    /** Test seams. */
    seams: {
      readonly s7cmd?: S7cmdRunner;
      readonly environment?: NodeJS.ProcessEnv;
    } = {},
  ) {
    const { bucket, deletes, exclude, ...filesystemOptions } = options;
    super(filesystemOptions);
    if (!FILESYSTEM_NAME_PATTERN.test(bucket)) {
      throw new Error(
        `bucket "${bucket}" must match ${FILESYSTEM_NAME_PATTERN}`,
      );
    }
    this.#s3Options = { bucket, deletes, exclude };
    this.#s7cmd = seams.s7cmd ?? runS7cmd;
    this.#environment = seams.environment ?? process.env;
  }

  protected override validate(mount: Mount): void {
    this.#remoteUrl(mount);
    if (this.#s3Options.deletes && mount.root === '') {
      throw new Error(
        `filesystem "${mount.name}": deletes needs a root, since on the whole bucket it could empty it`,
      );
    }
  }

  protected pull(mount: Mount): Promise<void> {
    return this.#sync([this.#remoteUrl(mount), `${mount.path}/`], []);
  }

  protected push(
    mount: Mount,
    options: { readonly modifiedBefore?: Date },
  ): Promise<void> {
    return this.#sync(
      [
        '--check-etag',
        ...(this.#s3Options.deletes ? ['--delete'] : []),
        ...(options.modifiedBefore === undefined
          ? []
          : ['--filter-mtime-before', options.modifiedBefore.toISOString()]),
        `${mount.path}/`,
        this.#remoteUrl(mount),
      ],
      outsideWriteScope(mount.write),
    );
  }

  #remoteUrl(mount: Mount): string {
    const declaredBuckets = z
      .record(z.string(), z.string().min(3))
      .parse(
        JSON.parse(this.#environment[FILESYSTEM_BUCKETS_VARIABLE] ?? '{}'),
      );
    const bucket = declaredBuckets[this.#s3Options.bucket];
    if (bucket === undefined) {
      throw new Error(
        `no bucket "${this.#s3Options.bucket}" is declared to this agent; declared: ${Object.keys(declaredBuckets).join(', ') || 'none'}`,
      );
    }
    return `s3://${bucket}/${mount.root === '' ? '' : `${mount.root}/`}`;
  }

  /** One `s7cmd sync`; any exit but 0 — an error, or a warning such as an ETag mismatch — is unsynced. */
  async #sync(
    args: readonly string[],
    additionalExclusions: readonly string[],
  ): Promise<void> {
    const exclude = [
      CLIMBING_PATH_PATTERN,
      ...this.#s3Options.exclude,
      ...additionalExclusions,
    ]
      .map((pattern) => `(?:${pattern})`)
      .join('|');
    const { exitCode, stderr } = await this.#s7cmd([
      'sync',
      '--filter-exclude-regex',
      exclude,
      ...args,
    ]);
    if (exitCode === 0) return;
    if (exitCode === S7CMD_EXIT_INVALID_ARGUMENTS) {
      throw new Error(
        `s7cmd refused its arguments; check \`exclude\`: ${stderr.trim()}`,
      );
    }
    throw new FilesystemUnsynced(`s7cmd exited ${exitCode}: ${stderr.trim()}`);
  }
}

/** A pattern matching every path outside the write scope; none when the scope is everything. */
function outsideWriteScope(write: readonly string[]): readonly string[] {
  if (write.includes('**')) return [];
  const writeScope = write
    .map((glob) => `(?:${picomatch.makeRe(glob, { dot: true }).source})`)
    .join('|');
  return [`^(?!${writeScope})`];
}
