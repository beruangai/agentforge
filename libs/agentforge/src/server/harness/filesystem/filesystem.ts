import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, matchesGlob, posix } from 'node:path';
import { z } from 'zod';
import {
  cause,
  type TerminalTaskState,
  TerminalTaskStateEnum,
} from '#core/contract/task.ts';
import type { FrameworkTypes, TaskContext } from '../framework.ts';
import { TaskFailure } from '../task-failure.ts';
import {
  type KeptCopy,
  recordKeptCopy,
  removeForeignKeptCopies,
  removeKeptCopy,
} from './kept-copies.ts';
import { claimLocalDirectory } from './mount-claims.ts';

/** The task states a filesystem may push on: a cancel never pushes, and a rejected task never mounts. */
export const PushOnStateEnum = TerminalTaskStateEnum.extract([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
]);
export type PushOnState = z.infer<typeof PushOnStateEnum>;

/**
 * What a filesystem's scope is resolved from: the request the procedure
 * serves. `Input` is the procedure's input as its contract parses it; a
 * filesystem typed by it can be registered only on procedures whose input
 * has that type, which `filesystems()` checks when the procedure compiles.
 */
export interface FilesystemRequest<Input = unknown> {
  /** Already parsed by the procedure's contract: read it, never parse it again. */
  readonly input: Input;
  readonly context: TaskContext<FrameworkTypes>;
}

/** Where under its roots a filesystem mounts for a request, and what within it may be written. A mount is readable whole. */
export interface FilesystemScope {
  /**
   * Relative to both roots: the mount is `<localRoot>/<subpath>` here and
   * `<remoteRoot>/<subpath>` in the store; `''` for the whole root.
   */
  readonly subpath: string;
  /** Globs relative to the mount; the whole mount by default when the filesystem pushes. A read-only filesystem's are none, and any it is given fail the task. A push never leaves them. */
  readonly write?: readonly string[];
}

/** Options every filesystem kind shares (ADR 0015). */
export interface FilesystemOptions<Input = unknown> {
  /** The local directory its mounts live under, absolute; a kind sets a default or requires it. */
  readonly localRoot?: string;
  /** The store's partition its mounts live under, absolute within the store; `/`, the whole store, when absent. */
  readonly remoteRoot?: string;
  readonly scope: (request: FilesystemRequest<Input>) => FilesystemScope;
  /**
   * The task states unmount pushes the write scope back on, verified before
   * the outcome is published: `['TASK_STATE_COMPLETED']`, or with
   * `'TASK_STATE_FAILED'` too. Absent, it never pushes: the filesystem is
   * read-only (`Filesystem.readOnly`).
   */
  readonly pushOn?: readonly PushOnState[];
  /** Also push every `intervalSeconds` while the task runs, only files unchanged for `settleSeconds` so writes in progress settle first; only when `pushOn` has `TASK_STATE_FAILED`, since they publish before the outcome is known. */
  readonly checkpoints?: {
    readonly intervalSeconds: number;
    readonly settleSeconds: number;
  };
  /**
   * Remove the local copy at unmount. Off, the copy is kept: the next task of
   * the same runtime session that mounts the same directory, for the same
   * store, starts from it, brought up to date by its pull.
   */
  readonly removeLocalCopy?: boolean;
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
    removeLocalCopy: z.boolean().optional(),
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
  readonly write: readonly string[];
  /** The request it was resolved for: a kind reads the task's identifiers from its context. */
  readonly request: FilesystemRequest;
}

/** What a permission lets an agent do. `delete` is stated when the filesystem enables deletes; no framework renders it. */
export type PermissionAction = 'read' | 'edit' | 'delete';

/** A baseline permission on a mount, in no framework's syntax: its framework renders it. */
export interface Permission {
  readonly action: PermissionAction;
  /** Relative to the mount's `localPath`; `**` for the whole mount. */
  readonly glob: string;
}

/** What the handler receives for a mounted filesystem: its local path, and permissions it may give an agent. */
export interface MountedFilesystem {
  readonly localPath: string;
  /** Claude Code permission rules: reading the whole mount, and editing its write scope. AgentForge applies none: the handler decides. */
  /** `read` on the whole mount first, then `edit` on each glob of its write scope. */
  readonly permissions: readonly Permission[];
  /** The local path of `relativePath` in the mount; throws if it is absolute or climbs out. */
  path(relativePath: string): string;
  /** As `path`, and throws unless a write glob of the scope matches it: a write outside the scope would never be pushed. */
  writablePath(relativePath: string): string;
  /**
   * Records and publishes the write scope now, with `message`, queued with
   * every other push of the mount. Present only where the kind offers the
   * agent a push and `pushOn` includes `TASK_STATE_FAILED`, since it
   * publishes before the outcome is known.
   */
  readonly push?: (message: string) => Promise<PushReport>;
  /** With `push`: true when the consumer's code shapes the message a push records from the one given, which a push tool tells the agent. */
  readonly shapesPushMessage?: boolean;
}

/** What a framework's push tool for the mount `name` tells the agent. */
export function pushToolDescription(
  name: string,
  mount: MountedFilesystem,
): string {
  return `Commits and pushes the write scope of the "${name}" filesystem now, with your message, so partial work survives if the task fails.${mount.shapesPushMessage === true ? ' Your message is not committed as given: the filesystem shapes the commit message from it, so say only what changed, in no commit convention of your own.' : ''} Returns the commit the write scope stands at and the files this push recorded, none when nothing changed.`;
}

/** What a push recorded, and where the write scope stands after it. */
export interface PushReport {
  /**
   * The commit at which the write scope stands as pushed: this push's, or,
   * when it had nothing to record, the mount's base — an earlier push's, or
   * the commit the mount pulled. Absent only when the branch has no commit.
   */
  readonly commit?: string;
  /** What this push recorded, relative to the mount; empty when it had nothing to record. */
  readonly files: readonly string[];
}

/** The store failed or disagreed; retrying may succeed. Kinds throw it from `pull` and `push`. */
export class FilesystemUnsynced extends Error {}

/**
 * A filesystem AgentForge manages for a procedure: mounted — pulled into a
 * local directory — before its handler, unmounted once its outcome is known.
 * A kind implements `pull` and `push`; the lifecycle — and checkpoints, which
 * are pushes of what has settled — is run from the options (ADR 0015).
 * `Input` types the request its scope reads (§REQ103).
 */
export abstract class Filesystem<in Input = unknown> {
  readonly options: FilesystemOptions<Input>;
  /** The local root for a registered name: the consumer's, or the kind's default. */
  readonly #resolveLocalRoot: (filesystem: { readonly name: string }) => string;

  protected constructor(
    options: FilesystemOptions<Input>,
    kind: {
      /** The local root when the consumer names none; absent, the consumer must. */
      readonly defaultLocalRoot?: (filesystem: {
        readonly name: string;
      }) => string;
      /** Whether its pushes delete: its mounts' permissions then add `delete` on each write glob. */
      readonly deletes?: boolean;
      /** Whether it has no store, so its writes stay in the task by design: it is then never read-only, and never pushes. */
      readonly localOnly?: boolean;
      /** Whether its agent push records a message the consumer's code shapes from the one given. */
      readonly shapesPushMessage?: boolean;
    } = {},
  ) {
    const parsed = FilesystemOptionsSchema.safeParse(options);
    if (!parsed.success) {
      throw new Error(
        `${this.constructor.name}'s options are invalid: ${z.prettifyError(parsed.error)}`,
      );
    }
    this.options = parsed.data as FilesystemOptions<Input>;
    const { localRoot } = this.options;
    const resolveLocalRoot =
      localRoot === undefined ? kind.defaultLocalRoot : () => localRoot;
    if (resolveLocalRoot === undefined) {
      throw new Error(
        `${this.constructor.name} needs a localRoot: the directory its mounts live under`,
      );
    }
    if (kind.localOnly === true && this.options.pushOn !== undefined) {
      throw new Error(
        `${this.constructor.name} has no store, so it never pushes: it takes no pushOn`,
      );
    }
    this.#resolveLocalRoot = resolveLocalRoot;
    this.#deletes = kind.deletes === true;
    this.#localOnly = kind.localOnly === true;
    this.#shapesPushMessage = kind.shapesPushMessage === true;
  }

  readonly #deletes: boolean;
  readonly #localOnly: boolean;
  readonly #shapesPushMessage: boolean;

  /**
   * A filesystem with a store and no `pushOn` is read-only, whatever its
   * kind: its mounts are readable whole, grant no edit, offer no push and
   * are never pushed, and a scope that grants it a write fails the task.
   */
  get readOnly(): boolean {
    return !this.#localOnly && this.options.pushOn === undefined;
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
   * Its store, as a kept copy is identified by: a copy left for another
   * store is removed before a mount, never reused (a bucket, a repository and
   * branch).
   */
  protected abstract storeIdentity(mount: Mount): string;

  /** State the kind keeps for a mount beside its local directory, removed with its copy. */
  protected privatePaths(_mount: Mount): readonly string[] {
    return [];
  }

  /** A push the agent may call mid-task, with its own message; a kind that offers one defines it. */
  protected agentPush?(mount: Mount, message: string): Promise<PushReport>;

  /**
   * Mounts what `resolve` resolved: refused by the kind, refused while
   * another live task in the container holds its local directory, or
   * claimed and pulled into it.
   */
  async mount(mount: Mount): Promise<MountLifecycle> {
    this.validate(mount);
    const kept: KeptCopy = {
      localPath: mount.localPath,
      kind: this.constructor.name,
      store: this.storeIdentity(mount),
      remotePath: mount.remotePath,
      runtimeSessionId: mount.request.context.runtimeSessionId,
      paths: [mount.localPath, ...this.privatePaths(mount)],
    };
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
      await removeForeignKeptCopies(kept);
      await recordKeptCopy(kept);
      await mkdir(mount.localPath, { recursive: true });
      await this.pull(mount);
    } catch (error) {
      // A failed pull may leave a partial copy, which must never be kept and later published.
      await removeKeptCopy(kept);
      await release();
      throw asTaskFailure(
        error,
        `filesystem "${mount.name}" could not be pulled`,
      );
    }
    const { agentPush } = this;
    return new MountLifecycle(this, mount, {
      push: (options) => this.push(mount, options),
      ...(agentPush !== undefined &&
      this.options.pushOn?.includes('TASK_STATE_FAILED') === true
        ? { agentPush: (message) => agentPush.call(this, mount, message) }
        : {}),
      deletes: this.#deletes,
      shapesPushMessage: this.#shapesPushMessage,
      release,
      remove: () => removeKeptCopy(kept),
    });
  }

  /**
   * Resolves the scope for a request: the subpath under both roots, and the
   * write scope within it. Nothing is touched; `mount` acts on it.
   */
  resolve(task: {
    readonly name: string;
    readonly taskId: string;
    readonly request: FilesystemRequest<Input>;
  }): Mount {
    const scope = this.options.scope(task.request);
    // Typed away, but a scope is the consumer's code: a dropped key would be silent.
    if (Object.hasOwn(scope, 'read')) {
      throw new Error(
        `filesystem "${task.name}": a scope's \`read\` is not supported: a mount is readable whole, and a run reads it as a working directory from \`context.agentOptions\``,
      );
    }
    const subpath = scope.subpath.replace(/\/+$/, '');
    if (subpath.startsWith('/') || hasDotSegment(subpath)) {
      throw new Error(
        `filesystem "${task.name}": a scope's subpath is relative to its roots, and never climbs: "${scope.subpath}"`,
      );
    }
    const localRoot = this.#resolveLocalRoot(task).replace(/\/+$/, '');
    const pushes = this.options.pushOn !== undefined;
    if (this.readOnly && (scope.write?.length ?? 0) > 0) {
      throw new Error(
        `filesystem "${task.name}" is read-only, having no pushOn, but its scope writes ${scope.write?.join(', ')}: a write there would never be published; declare pushOn, or drop the scope's write`,
      );
    }
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
      write,
      request: task.request,
    };
  }
}

/** What a mount's lifecycle acts with: its kind's operations, bound to the mount. */
export interface MountOperations {
  readonly push: (options: { readonly modifiedBefore?: Date }) => Promise<void>;
  readonly agentPush?: (message: string) => Promise<PushReport>;
  readonly deletes: boolean;
  readonly shapesPushMessage: boolean;
  /** Frees the local directory's claim. */
  readonly release: () => Promise<void>;
  /** Removes the local copy, the kind's state for it, and its record. */
  readonly remove: () => Promise<void>;
}

/** A mounted filesystem, held until the outcome is known: runs its checkpoints, and unmounts it. */
export class MountLifecycle {
  readonly name: string;
  readonly mounted: MountedFilesystem;
  /** Of any input: only its options are read. */
  readonly #filesystem: Filesystem<never>;
  readonly #operations: MountOperations;
  #checkpointTimer: ReturnType<typeof setInterval> | undefined;
  /** Pushes run one at a time: a checkpoint, or an agent's push, never overlaps another. */
  #latestPush: Promise<unknown> = Promise.resolve();
  /** A tick while a checkpoint is still pushing is skipped, so a slow store builds no backlog for unmount to wait through. */
  #checkpointInFlight = false;

  constructor(
    filesystem: Filesystem<never>,
    mount: Mount,
    operations: MountOperations,
  ) {
    this.#filesystem = filesystem;
    this.#operations = operations;
    this.name = mount.name;
    const { agentPush } = operations;
    this.mounted = {
      localPath: mount.localPath,
      path: (relativePath) => pathIn(mount, relativePath),
      writablePath: (relativePath) => {
        const resolved = pathIn(mount, relativePath);
        const inMount = posix.normalize(relativePath);
        if (filesystem.readOnly) {
          throw new Error(
            `filesystem "${mount.name}" is read-only: "${relativePath}" may be read, never written`,
          );
        }
        if (!mount.write.some((glob) => matchesGlob(inMount, glob))) {
          throw new Error(
            `filesystem "${mount.name}": "${relativePath}" is outside its write scope (${mount.write.join(', ')}), so a write there would never be pushed`,
          );
        }
        return resolved;
      },
      permissions: [
        { action: 'read', glob: '**' },
        ...mount.write.map((glob) => ({ action: 'edit' as const, glob })),
        ...(operations.deletes
          ? mount.write.map((glob) => ({ action: 'delete' as const, glob }))
          : []),
      ],
      ...(agentPush === undefined
        ? {}
        : {
            push: (message: string) => this.#queue(() => agentPush(message)),
            shapesPushMessage: operations.shapesPushMessage,
          }),
    };
    const { checkpoints } = filesystem.options;
    if (checkpoints !== undefined) {
      this.#checkpointTimer = setInterval(() => {
        if (this.#checkpointInFlight) return;
        this.#checkpointInFlight = true;
        const modifiedBefore = new Date(
          Date.now() - checkpoints.settleSeconds * 1000,
        );
        this.#queue(() => this.#operations.push({ modifiedBefore }))
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

  /** Pushes if `pushOn` has the state the task ended in, then removes the local copy if the filesystem says so, and frees its claim. */
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
          await this.#queue(() => this.#operations.push({}));
        } catch (error) {
          throw asTaskFailure(
            error,
            `filesystem "${this.name}" could not be pushed`,
          );
        }
      }
    } finally {
      if (this.#filesystem.options.removeLocalCopy === true) {
        await this.#operations.remove();
      }
      await this.#operations.release();
    }
  }

  #queue<T>(push: () => Promise<T>): Promise<T> {
    const next = this.#latestPush.catch(() => undefined).then(push);
    this.#latestPush = next;
    return next;
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
