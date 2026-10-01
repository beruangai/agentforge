import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join, matchesGlob, posix } from 'node:path';
import { z } from 'zod';
import {
  cause,
  type TerminalTaskState,
  TerminalTaskStateEnum,
} from '#core/contract/task.ts';
import { TaskFailure } from '../kernel.ts';
import type { TaskContext } from '../task-process.ts';
import { claimLocalDirectory } from './mount-claims.ts';

/** The task states a filesystem may push on: a cancel never pushes, and a rejected task never mounts. */
export const PushOnStateEnum = TerminalTaskStateEnum.extract([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
]);
export type PushOnState = z.infer<typeof PushOnStateEnum>;

/** What a filesystem's scope is resolved from: the request the procedure serves. */
export interface FilesystemRequest {
  /** Validated against the procedure's contract. */
  readonly input: unknown;
  readonly context: TaskContext;
}

/** Where under its roots a filesystem mounts for a request, and what within it the agent may read and write. */
export interface FilesystemScope {
  /**
   * Relative to both roots: the mount is `<localRoot>/<subpath>` here and
   * `<remoteRoot>/<subpath>` in the store; `''` for the whole root.
   */
  readonly subpath: string;
  /** Globs relative to the mount; the whole mount by default. */
  readonly read?: readonly string[];
  /** Globs relative to the mount; the whole mount by default when the filesystem pushes, none when it does not. A push never leaves them. */
  readonly write?: readonly string[];
}

/** Options every filesystem kind shares (ADR 0015). */
export interface FilesystemOptions {
  /** The local directory its mounts live under, absolute; a kind sets a default or requires it. */
  readonly localRoot?: string;
  /** The store's partition its mounts live under, absolute within the store; `/`, the whole store, when absent. */
  readonly remoteRoot?: string;
  readonly scope: (request: FilesystemRequest) => FilesystemScope;
  /**
   * The task states unmount pushes the write scope back on, verified before
   * the outcome is published: `['TASK_STATE_COMPLETED']`, or with
   * `'TASK_STATE_FAILED'` too. Absent, it never pushes.
   */
  readonly pushOn?: readonly PushOnState[];
  /** Also push every `intervalSeconds` while the task runs, only files unchanged for `settleSeconds` so writes in progress settle first; only when `pushOn` has `TASK_STATE_FAILED`, since they publish before the outcome is known. */
  readonly checkpoints?: {
    readonly intervalSeconds: number;
    readonly settleSeconds: number;
  };
}

/** Strict: a misspelt option is refused, never dropped. A kind strips its own before these. */
const FilesystemOptionsSchema = z
  .strictObject({
    localRoot: z
      .string()
      .refine(isAbsolute, 'a local root is an absolute directory')
      .refine(
        (root) => !hasDotSegment(root),
        'a local root has no "." or ".." segment',
      )
      .optional(),
    remoteRoot: z
      .string()
      .refine(
        (root) => root.startsWith('/'),
        'a remote root is absolute within its store: it starts with "/"',
      )
      .refine(
        (root) => !hasDotSegment(root),
        'a remote root has no "." or ".." segment',
      )
      .optional(),
    scope: z.custom<FilesystemOptions['scope']>(
      (value) => typeof value === 'function',
      'scope is a function of the request',
    ),
    pushOn: z.array(PushOnStateEnum).min(1).optional(),
    checkpoints: z
      .strictObject({
        intervalSeconds: z.number().int().min(5),
        settleSeconds: z.number().int().min(0),
      })
      .optional(),
  })
  .refine(
    (options) =>
      options.checkpoints === undefined ||
      options.pushOn?.includes('TASK_STATE_FAILED') === true,
    'checkpoints publish files before the outcome is known: they need `pushOn` to include "TASK_STATE_FAILED"',
  );

/** One mounted filesystem, as the scope resolved it for this task. */
export interface Mount {
  readonly name: string;
  readonly taskId: string;
  /** The local directory it is mounted at: `<localRoot>/<subpath>`, absolute. */
  readonly localPath: string;
  /** What it mounts from the store: `<remoteRoot>/<subpath>`, absolute within the store, `/` for all of it. A kind maps it to its store's addressing. */
  readonly remotePath: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** What the handler receives for a mounted filesystem: its local path, and permissions it may give an agent. */
export interface MountedFilesystem {
  readonly localPath: string;
  /** Claude Code permission rules for its read and write scopes. AgentForge applies none: the handler decides. */
  readonly permissions: { readonly allow: readonly string[] };
  /** The local path of `relativePath` in the mount; throws if it is absolute or climbs out. */
  path(relativePath: string): string;
  /** As `path`, and throws unless a write glob of the scope matches it: a write outside the scope would never be pushed. */
  writablePath(relativePath: string): string;
}

/** The store failed or disagreed; retrying may succeed. Kinds throw it from `pull` and `push`. */
export class FilesystemUnsynced extends Error {}

/**
 * A filesystem AgentForge manages for a procedure: mounted — pulled into a
 * local directory — before its handler, unmounted once its outcome is known.
 * A kind implements `pull` and `push`; the lifecycle — and checkpoints, which
 * are pushes of what has settled — is run from the options (ADR 0015).
 */
export abstract class Filesystem {
  readonly options: FilesystemOptions;
  /** The local root for a registered name: the consumer's, or the kind's default. */
  readonly #resolveLocalRoot: (filesystem: { readonly name: string }) => string;

  protected constructor(
    options: FilesystemOptions,
    kind: {
      /** The local root when the consumer names none; absent, the consumer must. */
      readonly defaultLocalRoot?: (filesystem: {
        readonly name: string;
      }) => string;
    } = {},
  ) {
    const parsed = FilesystemOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new Error(
        `${this.constructor.name}'s options are invalid: ${z.prettifyError(parsed.error)}`,
      );
    }
    this.options = parsed.data as FilesystemOptions;
    const { localRoot } = this.options;
    const resolveLocalRoot =
      localRoot === undefined ? kind.defaultLocalRoot : () => localRoot;
    if (resolveLocalRoot === undefined) {
      throw new Error(
        `${this.constructor.name} needs a localRoot: the directory its mounts live under`,
      );
    }
    this.#resolveLocalRoot = resolveLocalRoot;
  }

  /** Fetches the scope's contents into the mount; every mount pulls, so a task starts from the store, never blind. */
  protected abstract pull(mount: Mount): Promise<void>;

  /** Sends the write scope's changes back; with `modifiedBefore`, only files last modified before it. */
  protected abstract push(
    mount: Mount,
    options: { readonly modifiedBefore?: Date },
  ): Promise<void>;

  /** Refuses a mount the kind cannot honour, before anything is fetched. */
  protected validate(_mount: Mount): void {}

  /**
   * Mounts what `resolve` resolved: refused by the kind, refused while
   * another live task in the container holds its local directory, or
   * claimed and pulled into it.
   */
  async mount(mount: Mount): Promise<MountLifecycle> {
    this.validate(mount);
    let release: () => Promise<void>;
    try {
      release = await claimLocalDirectory(mount);
    } catch (error) {
      throw asTaskFailure(
        error,
        `filesystem "${mount.name}" could not be mounted`,
      );
    }
    try {
      await mkdir(mount.localPath, { recursive: true });
      await this.pull(mount);
    } catch (error) {
      await rm(mount.localPath, { recursive: true, force: true });
      await release();
      throw asTaskFailure(
        error,
        `filesystem "${mount.name}" could not be pulled`,
      );
    }
    return new MountLifecycle(
      this,
      mount,
      (options) => this.push(mount, options),
      release,
    );
  }

  /**
   * Resolves the scope for a request: the subpath under both roots, and the
   * read and write scopes within it. Nothing is touched; `mount` acts on it.
   */
  resolve(task: {
    readonly name: string;
    readonly taskId: string;
    readonly request: FilesystemRequest;
  }): Mount {
    const scope = this.options.scope(task.request);
    const subpath = scope.subpath.replace(/\/+$/, '');
    if (subpath.startsWith('/') || hasDotSegment(subpath)) {
      throw new Error(
        `filesystem "${task.name}": a scope's subpath is relative to its roots, and never climbs: "${scope.subpath}"`,
      );
    }
    const localRoot = this.#resolveLocalRoot(task).replace(/\/+$/, '');
    const pushes = this.options.pushOn !== undefined;
    const write = scope.write ?? (pushes ? ['**'] : []);
    if (pushes && write.length === 0) {
      throw new Error(
        `filesystem "${task.name}" pushes, but its scope writes nothing`,
      );
    }
    return {
      name: task.name,
      taskId: task.taskId,
      localPath: subpath === '' ? localRoot : join(localRoot, subpath),
      remotePath: posix
        .join(this.options.remoteRoot ?? '/', subpath)
        .replace(/(.)\/+$/, '$1'),
      read: scope.read ?? ['**'],
      write,
    };
  }
}

/** A mounted filesystem, held until the outcome is known: runs its checkpoints, and unmounts it. */
export class MountLifecycle {
  readonly name: string;
  readonly mounted: MountedFilesystem;
  readonly #filesystem: Filesystem;
  readonly #mount: Mount;
  readonly #push: (options: {
    readonly modifiedBefore?: Date;
  }) => Promise<void>;
  /** Frees the local directory's claim, once it is removed. */
  readonly #release: () => Promise<void>;
  #checkpointTimer: ReturnType<typeof setInterval> | undefined;
  /** Pushes run one at a time: a checkpoint never overlaps the last. */
  #latestPush: Promise<void> = Promise.resolve();
  /** A tick while a checkpoint is still pushing is skipped, so a slow store builds no backlog for unmount to wait through. */
  #checkpointInFlight = false;

  constructor(
    filesystem: Filesystem,
    mount: Mount,
    push: (options: { readonly modifiedBefore?: Date }) => Promise<void>,
    release: () => Promise<void>,
  ) {
    this.#filesystem = filesystem;
    this.#mount = mount;
    this.#push = push;
    this.#release = release;
    this.name = mount.name;
    this.mounted = {
      localPath: mount.localPath,
      path: (relativePath) => pathIn(mount, relativePath),
      writablePath: (relativePath) => {
        const resolved = pathIn(mount, relativePath);
        const inMount = posix.normalize(relativePath);
        if (!mount.write.some((glob) => matchesGlob(inMount, glob))) {
          throw new Error(
            `filesystem "${mount.name}": "${relativePath}" is outside its write scope (${mount.write.join(', ') || 'none'}), so a write there would never be pushed`,
          );
        }
        return resolved;
      },
      permissions: {
        allow: [
          ...mount.read.map((glob) => `Read(/${mount.localPath}/${glob})`),
          ...mount.write.map((glob) => `Edit(/${mount.localPath}/${glob})`),
        ],
      },
    };
    const { checkpoints } = filesystem.options;
    if (checkpoints !== undefined) {
      this.#checkpointTimer = setInterval(() => {
        if (this.#checkpointInFlight) return;
        this.#checkpointInFlight = true;
        const modifiedBefore = new Date(
          Date.now() - checkpoints.settleSeconds * 1000,
        );
        this.#queuePush({ modifiedBefore })
          .catch((error: unknown) => {
            // The push at the end is the one the outcome waits on.
            console.error(
              `filesystem "${this.name}": a checkpoint failed`,
              error,
            );
          })
          .finally(() => {
            this.#checkpointInFlight = false;
          });
      }, checkpoints.intervalSeconds * 1000);
    }
  }

  /** Pushes if `pushOn` has the state the task ended in, then removes the local copy and frees its claim. */
  async unmount(
    state: Exclude<TerminalTaskState, 'TASK_STATE_REJECTED'>,
  ): Promise<void> {
    clearInterval(this.#checkpointTimer);
    try {
      await this.#latestPush.catch(() => undefined);
      const shouldPush =
        state !== 'TASK_STATE_CANCELED' &&
        this.#filesystem.options.pushOn?.includes(state) === true;
      if (shouldPush) {
        try {
          await this.#queuePush({});
        } catch (error) {
          throw asTaskFailure(
            error,
            `filesystem "${this.name}" could not be pushed`,
          );
        }
      }
    } finally {
      await rm(this.#mount.localPath, { recursive: true, force: true });
      await this.#release();
    }
  }

  #queuePush(options: { readonly modifiedBefore?: Date }): Promise<void> {
    this.#latestPush = this.#latestPush
      .catch(() => undefined)
      .then(() => this.#push(options));
    return this.#latestPush;
  }
}

/** Whether any segment of a slash-separated path is `.` or `..`. */
function hasDotSegment(path: string): boolean {
  return path.split('/').some((segment) => segment === '.' || segment === '..');
}

/** `relativePath` within the mount's local directory; refused when absolute or climbing out of it. */
function pathIn(mount: Mount, relativePath: string): string {
  const inMount = posix.normalize(relativePath);
  if (
    isAbsolute(relativePath) ||
    inMount === '..' ||
    inMount.startsWith('../')
  ) {
    throw new Error(
      `filesystem "${mount.name}": "${relativePath}" is not a path inside its mount at ${mount.localPath}`,
    );
  }
  return join(mount.localPath, inMount);
}

/** A store's failure becomes `FILESYSTEM_UNSYNCED`; anything else is the procedure's error, as it is. */
function asTaskFailure(error: unknown, failure: string): unknown {
  if (!(error instanceof FilesystemUnsynced)) return error;
  return new TaskFailure(
    cause('FILESYSTEM_UNSYNCED', `${failure}: ${error.message}`),
  );
}
