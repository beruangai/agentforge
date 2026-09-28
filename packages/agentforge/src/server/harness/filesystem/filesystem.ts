import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import {
  cause,
  type TerminalTaskState,
  TerminalTaskStateEnum,
} from '#core/contract/task.ts';
import { TaskFailure } from '../kernel.ts';
import type { TaskContext } from '../task-process.ts';

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

/** What a filesystem mounts from its store, and what within it the agent may read and write. */
export interface FilesystemScope {
  /** The subtree mounted — an S3 prefix, a path in a repository — relative; `''` for all of it. */
  readonly remotePath: string;
  /** Globs relative to the mount; the whole mount by default. */
  readonly read?: readonly string[];
  /** Globs relative to the mount; the whole mount by default when the filesystem pushes, none when it does not. A push never leaves them. */
  readonly write?: readonly string[];
}

/** Options every filesystem kind shares (ADR 0015). */
export interface FilesystemOptions {
  /** The local directory it mounts at, absolute; a kind sets a default or requires it. */
  readonly localPath?: string;
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

const FilesystemOptionsSchema = z
  .object({
    localPath: z
      .string()
      .refine(isAbsolute, 'a filesystem mounts at an absolute local path')
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
  /** The local directory it is mounted at: absolute. */
  readonly localPath: string;
  readonly remotePath: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** What the handler receives for a mounted filesystem: its local path, and permissions it may give an agent. */
export interface MountedFilesystem {
  readonly localPath: string;
  /** Claude Code permission rules for its read and write scopes. AgentForge applies none: the handler decides. */
  readonly permissions: { readonly allow: readonly string[] };
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
  /** The local directory it mounts at for a task: the consumer's, or the kind's default. */
  readonly #resolveLocalPath: (task: {
    readonly taskId: string;
    readonly name: string;
  }) => string;

  protected constructor(
    options: FilesystemOptions,
    kind: {
      /** The local directory it mounts at when the consumer names none; absent, the consumer must. */
      readonly defaultLocalPath?: (task: {
        readonly taskId: string;
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
    const { localPath } = this.options;
    const resolveLocalPath =
      localPath === undefined ? kind.defaultLocalPath : () => localPath;
    if (resolveLocalPath === undefined) {
      throw new Error(
        `${this.constructor.name} needs a localPath: where it mounts`,
      );
    }
    this.#resolveLocalPath = resolveLocalPath;
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

  async mount(task: {
    readonly name: string;
    readonly taskId: string;
    readonly request: FilesystemRequest;
  }): Promise<MountLifecycle> {
    const mount = this.#resolve(task);
    this.validate(mount);
    await mkdir(mount.localPath, { recursive: true });
    try {
      await this.pull(mount);
    } catch (error) {
      await rm(mount.localPath, { recursive: true, force: true });
      throw asTaskFailure(
        error,
        `filesystem "${mount.name}" could not be pulled`,
      );
    }
    return new MountLifecycle(this, mount, (options) =>
      this.push(mount, options),
    );
  }

  #resolve(task: {
    readonly name: string;
    readonly taskId: string;
    readonly request: FilesystemRequest;
  }): Mount {
    const scope = this.options.scope(task.request);
    const remotePath = scope.remotePath.replace(/\/+$/, '');
    if (
      remotePath.startsWith('/') ||
      remotePath
        .split('/')
        .some((segment) => segment === '..' || segment === '.')
    ) {
      throw new Error(
        `filesystem "${task.name}": a scope's remotePath is relative, and never climbs: "${scope.remotePath}"`,
      );
    }
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
      localPath: this.#resolveLocalPath(task).replace(/\/+$/, ''),
      remotePath,
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
  #checkpointTimer: ReturnType<typeof setInterval> | undefined;
  /** Pushes run one at a time: a checkpoint never overlaps the last. */
  #latestPush: Promise<void> = Promise.resolve();

  constructor(
    filesystem: Filesystem,
    mount: Mount,
    push: (options: { readonly modifiedBefore?: Date }) => Promise<void>,
  ) {
    this.#filesystem = filesystem;
    this.#mount = mount;
    this.#push = push;
    this.name = mount.name;
    this.mounted = {
      localPath: mount.localPath,
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
        const modifiedBefore = new Date(
          Date.now() - checkpoints.settleSeconds * 1000,
        );
        this.#queuePush({ modifiedBefore }).catch((error: unknown) => {
          // The push at the end is the one the outcome waits on.
          console.error(
            `filesystem "${this.name}": a checkpoint failed`,
            error,
          );
        });
      }, checkpoints.intervalSeconds * 1000);
    }
  }

  /** Pushes if `pushOn` has the state the task ended in, then removes the local copy. */
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
    }
  }

  #queuePush(options: { readonly modifiedBefore?: Date }): Promise<void> {
    this.#latestPush = this.#latestPush
      .catch(() => undefined)
      .then(() => this.#push(options));
    return this.#latestPush;
  }
}

/** A store's failure becomes `FILESYSTEM_UNSYNCED`; anything else is the procedure's error, as it is. */
function asTaskFailure(error: unknown, failure: string): unknown {
  if (!(error instanceof FilesystemUnsynced)) return error;
  return new TaskFailure(
    cause('FILESYSTEM_UNSYNCED', `${failure}: ${error.message}`),
  );
}
