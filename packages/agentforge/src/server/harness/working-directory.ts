import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /**
   * Also push while the task runs, so a lost container loses little, leaving
   * any file changed in the last `quietSeconds` for the next pass; only with
   * `WHEN_ENDED`.
   */
  continuous: z.union([
    z.literal(false),
    z.strictObject({
      everySeconds: z.number().int().min(5),
      quietSeconds: z.number().int().min(0),
    }),
  ]),
  /**
   * Whether a push deletes the objects under the prefix that the task
   * removed; only with `pull`, on a non-empty prefix.
   */
  deletes: z.boolean(),
  /**
   * Regular expressions (`s7cmd`'s syntax) over paths relative to the
   * prefix: never pulled, pushed or deleted.
   */
  exclude: z.array(z.string().min(1)),
});
export type WorkingDirectorySync = z.infer<typeof WorkingDirectorySyncSchema>;

export const WorkingDirectorySpecSchema = z
  .strictObject({
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
    sync: WorkingDirectorySyncSchema,
  })
  .refine(
    ({ sync }) => sync.continuous === false || sync.push === 'WHEN_ENDED',
    'a continuous push publishes files before the outcome is known: it needs `push: "WHEN_ENDED"`',
  )
  .refine(
    ({ sync }) => !sync.deletes || sync.pull,
    'deletes needs `pull`: without it, a push deletes every object the task did not write',
  )
  .refine(
    ({ sync, prefix }) => !sync.deletes || normalizedPrefix(prefix) !== '',
    'deletes needs a prefix: on the whole working directory it could empty it',
  );
export type WorkingDirectorySpec = z.infer<typeof WorkingDirectorySpecSchema>;

export interface OpenWorkingDirectory {
  /** The local directory holding the prefix: add it to the run's `additionalDirectories`. */
  readonly path: string;
}

type Ending = 'COMPLETED' | 'FAILED' | 'CANCELED';

/** How one `s7cmd` run ended. */
export interface S7cmdResult {
  readonly exitCode: number;
  /** The end of what it wrote to stderr. */
  readonly stderr: string;
}

export type S7cmdRunner = (args: readonly string[]) => Promise<S7cmdResult>;

export interface WorkingDirectoriesOptions {
  /** The bucket behind each declared working directory, by name. */
  readonly buckets: Readonly<Record<string, string>>;
  /** A test seam: runs `s7cmd`. */
  readonly s7cmd?: S7cmdRunner;
  /** Where tasks' local copies go, one directory per task; the system's temporary directory by default. */
  readonly root?: string;
}

/** The base image installs it on the `PATH` (packages/agentforge/Dockerfile). */
const S7CMD = 's7cmd';
/** How much of `s7cmd`'s stderr a failure carries. */
const STDERR_TAIL_CHARACTERS = 2_000;
/** `s7cmd` refused its arguments: a bad `exclude` pattern, or AgentForge's bug. */
const S7CMD_INVALID_ARGUMENTS = 2;
/**
 * Excluded always, in both directions: a key with a `..` segment would write
 * outside the directory on a pull.
 */
const CLIMBING_PATH = '(^|/)\\.\\.(/|$)';

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
              `${S7CMD} is not on the PATH: working directories run in AgentForge's base image, which installs it`,
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
 * pulled into a directory of the task's own and pushed back as its sync
 * says, by `s7cmd`, which verifies each object it transfers (ADR 0015).
 */
export class TaskWorkingDirectories {
  readonly #root: string;
  readonly #buckets: Readonly<Record<string, string>>;
  readonly #s7cmd: S7cmdRunner;
  readonly #open = new Map<string, OpenDirectory>();

  constructor(
    options: WorkingDirectoriesOptions & { readonly taskId: string },
  ) {
    this.#root = join(
      options.root ?? join(tmpdir(), 'agentforge-working'),
      options.taskId,
    );
    this.#buckets = options.buckets;
    this.#s7cmd = options.s7cmd ?? runS7cmd;
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
    const directory = new OpenDirectory({
      spec,
      path: join(this.#root, spec.name),
      remote: `s3://${bucket}/${normalizedPrefix(spec.prefix)}`,
      s7cmd: this.#s7cmd,
    });
    this.#open.set(spec.name, directory);
    await directory.start();
    return { path: directory.path };
  }

  /**
   * Stops continuous pushes, then pushes each directory whose sync covers
   * how the task ended. Throws a `WORKING_DIRECTORY_UNSYNCED` failure naming
   * every directory that did not sync.
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
  readonly path: string;
  readonly #spec: WorkingDirectorySpec;
  readonly #remote: string;
  readonly #s7cmd: S7cmdRunner;
  readonly #exclude: string;
  #continuous: ReturnType<typeof setInterval> | undefined;
  /** Pushes run one at a time: a continuous push never overlaps the last. */
  #pushing: Promise<void> = Promise.resolve();

  constructor(options: {
    readonly spec: WorkingDirectorySpec;
    readonly path: string;
    readonly remote: string;
    readonly s7cmd: S7cmdRunner;
  }) {
    this.path = options.path;
    this.#spec = options.spec;
    this.#remote = options.remote;
    this.#s7cmd = options.s7cmd;
    this.#exclude = [CLIMBING_PATH, ...options.spec.sync.exclude]
      .map((pattern) => `(?:${pattern})`)
      .join('|');
  }

  get name(): string {
    return this.#spec.name;
  }

  async start(): Promise<void> {
    await mkdir(this.path, { recursive: true });
    if (this.#spec.sync.pull) {
      try {
        await this.#sync([this.#remote, `${this.path}/`]);
      } catch (error) {
        if (!(error instanceof Unsynced)) throw error;
        throw new TaskFailure(
          cause(
            'WORKING_DIRECTORY_UNSYNCED',
            `working directory "${this.name}" could not be pulled: ${error.message}`,
          ),
        );
      }
    }
    const { continuous } = this.#spec.sync;
    if (continuous !== false) {
      this.#continuous = setInterval(() => {
        const cutoff = new Date(Date.now() - continuous.quietSeconds * 1000);
        this.#push(['--filter-mtime-before', cutoff.toISOString()]).catch(
          (error: unknown) => {
            // The push at the end is the one the outcome waits on.
            console.error(
              `working directory "${this.name}": a continuous push failed`,
              error,
            );
          },
        );
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
    if (pushes) await this.#push([]);
  }

  #push(extra: readonly string[]): Promise<void> {
    this.#pushing = this.#pushing
      .catch(() => undefined)
      .then(() =>
        this.#sync([
          '--check-etag',
          ...(this.#spec.sync.deletes ? ['--delete'] : []),
          ...extra,
          `${this.path}/`,
          this.#remote,
        ]),
      );
    return this.#pushing;
  }

  /** One `s7cmd sync`; any exit but 0 — an error, or a warning such as an ETag mismatch — is unsynced. */
  async #sync(args: readonly string[]): Promise<void> {
    const { exitCode, stderr } = await this.#s7cmd([
      'sync',
      '--filter-exclude-regex',
      this.#exclude,
      ...args,
    ]);
    if (exitCode === 0) return;
    if (exitCode === S7CMD_INVALID_ARGUMENTS) {
      throw new Error(
        `s7cmd refused the sync of working directory "${this.name}"; check its \`exclude\` patterns: ${stderr.trim()}`,
      );
    }
    throw new Unsynced(`s7cmd exited ${exitCode}: ${stderr.trim()}`);
  }
}

/** The object store failed or disagreed; retrying may succeed. */
class Unsynced extends Error {}

function normalizedPrefix(prefix: string): string {
  const trimmed = prefix.replace(/\/+$/, '');
  return trimmed === '' ? '' : `${trimmed}/`;
}
