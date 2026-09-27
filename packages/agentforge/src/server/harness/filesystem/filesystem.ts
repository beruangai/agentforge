import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { cause } from '#core/contract/task.ts';
import { TaskFailure } from '../kernel.ts';
import type { TaskContext } from '../task-process.ts';

/** How a task ended, which decides what an unmount pushes. */
export type Ending = 'COMPLETED' | 'FAILED' | 'CANCELED';

/** What a filesystem's scope is resolved from: the request the procedure serves. */
export interface FilesystemRequest {
  /** Validated against the procedure's contract. */
  readonly input: unknown;
  readonly context: TaskContext;
}

/** What a filesystem mounts, and what within it the agent may read and write. */
export interface FilesystemScope {
  /** The subtree mounted — an S3 prefix, a path in a repository — relative; `''` for all of it. */
  readonly root: string;
  /** Globs relative to the mount; the whole mount by default. */
  readonly read?: readonly string[];
  /** Globs relative to the mount; the whole mount by default, none when read-only. A push never leaves them. */
  readonly write?: readonly string[];
}

/**
 * What every filesystem declares, whole: AgentForge has no defaults, so a
 * house declares its own as a value its procedures spread (ADR 0015).
 */
export interface FilesystemOptions {
  /** Where it mounts, absolute; a kind sets a default or requires it. */
  readonly path?: string;
  readonly access: 'READ_ONLY' | 'READ_WRITE';
  readonly scope: (request: FilesystemRequest) => FilesystemScope;
  /** When it goes back, verified before the outcome is published; never after a cancel. */
  readonly push: 'NEVER' | 'WHEN_COMPLETED' | 'WHEN_ENDED';
  /** Also push every `everySeconds` while the task runs, only files unchanged for `settleSeconds` so writes in progress settle first; only with `WHEN_ENDED`. */
  readonly checkpoints:
    | false
    | { readonly everySeconds: number; readonly settleSeconds: number };
}

const FilesystemOptionsSchema = z
  .object({
    path: z
      .string()
      .refine(isAbsolute, 'a filesystem mounts at an absolute path')
      .optional(),
    access: z.enum(['READ_ONLY', 'READ_WRITE']),
    scope: z.custom<FilesystemOptions['scope']>(
      (value) => typeof value === 'function',
      'scope is a function of the request',
    ),
    push: z.enum(['NEVER', 'WHEN_COMPLETED', 'WHEN_ENDED']),
    checkpoints: z.union([
      z.literal(false),
      z.strictObject({
        everySeconds: z.number().int().min(5),
        settleSeconds: z.number().int().min(0),
      }),
    ]),
  })
  .refine(
    (options) => options.checkpoints === false || options.push === 'WHEN_ENDED',
    'checkpoints publish files before the outcome is known: they need `push: "WHEN_ENDED"`',
  )
  .refine(
    (options) =>
      options.access === 'READ_WRITE' ||
      (options.push === 'NEVER' && options.checkpoints === false),
    'a read-only filesystem never pushes',
  );

/** One mounted filesystem, as the scope resolved it for this task. */
export interface Mount {
  readonly name: string;
  readonly taskId: string;
  /** Where it is mounted: absolute. */
  readonly path: string;
  readonly root: string;
  readonly read: readonly string[];
  readonly write: readonly string[];
}

/** What the handler receives for a mounted filesystem: its path, and permissions it may give an agent. */
export interface MountedFilesystem {
  readonly path: string;
  /** Claude Code permission rules for its read and write scopes. AgentForge applies none: the handler decides. */
  readonly permissions: { readonly allow: readonly string[] };
}

/** A mounted filesystem, as the lifecycle holds it until the outcome is known. */
export interface MountedHandle {
  readonly name: string;
  readonly mounted: MountedFilesystem;
  unmount(ending: Ending): Promise<void>;
}

/** The store failed or disagreed; retrying may succeed. Kinds throw it from `pull` and `push`. */
export class FilesystemUnsynced extends Error {}

/**
 * A filesystem AgentForge manages for a procedure: mounted before its
 * handler, unmounted once its outcome is known. A kind implements `pull` and
 * `push`; the lifecycle — and checkpoints, which are pushes of what has
 * settled — is run from the options (ADR 0015).
 */
export abstract class Filesystem {
  readonly options: FilesystemOptions;
  /** Where it mounts for a task: the consumer's path, or the kind's default. */
  readonly #pathOf: (task: {
    readonly taskId: string;
    readonly name: string;
  }) => string;

  protected constructor(
    options: FilesystemOptions,
    kind: {
      /** Where it mounts when the consumer names no path; absent, the consumer must. */
      readonly defaultPath?: (task: {
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
    const { path } = this.options;
    const pathOf = path === undefined ? kind.defaultPath : () => path;
    if (pathOf === undefined) {
      throw new Error(`${this.constructor.name} needs a path: where it mounts`);
    }
    this.#pathOf = pathOf;
  }

  /** Fetches the scope's contents into the mount; every mount pulls, so a task starts from the store, never blind. */
  protected abstract pull(mount: Mount): Promise<void>;

  /** Sends the write scope's changes back; `settledBefore` leaves what changed after it. */
  protected abstract push(
    mount: Mount,
    options: { readonly settledBefore?: Date },
  ): Promise<void>;

  /** Refuses a mount the kind cannot honour, before anything is fetched. */
  protected validate(_mount: Mount): void {}

  async mount(task: {
    readonly name: string;
    readonly taskId: string;
    readonly request: FilesystemRequest;
  }): Promise<MountedHandle> {
    const mount = this.#resolve(task);
    this.validate(mount);
    await mkdir(mount.path, { recursive: true });
    try {
      await this.pull(mount);
    } catch (error) {
      await rm(mount.path, { recursive: true, force: true });
      throw unsyncedOr(error, `filesystem "${mount.name}" could not be pulled`);
    }
    return new Lifecycle(this, mount, (options) => this.push(mount, options));
  }

  #resolve(task: {
    readonly name: string;
    readonly taskId: string;
    readonly request: FilesystemRequest;
  }): Mount {
    const scope = this.options.scope(task.request);
    const root = scope.root.replace(/\/+$/, '');
    if (
      root.startsWith('/') ||
      root.split('/').some((segment) => segment === '..' || segment === '.')
    ) {
      throw new Error(
        `filesystem "${task.name}": a scope's root is relative, and never climbs: "${scope.root}"`,
      );
    }
    const readWrite = this.options.access === 'READ_WRITE';
    const write = scope.write ?? (readWrite ? ['**'] : []);
    if (!readWrite && write.length > 0) {
      throw new Error(
        `filesystem "${task.name}" is read-only: its scope cannot write`,
      );
    }
    return {
      name: task.name,
      taskId: task.taskId,
      path: this.#pathOf(task).replace(/\/+$/, ''),
      root,
      read: scope.read ?? ['**'],
      write,
    };
  }
}

class Lifecycle implements MountedHandle {
  readonly name: string;
  readonly mounted: MountedFilesystem;
  readonly #filesystem: Filesystem;
  readonly #mount: Mount;
  readonly #push: (options: { readonly settledBefore?: Date }) => Promise<void>;
  #checkpoints: ReturnType<typeof setInterval> | undefined;
  /** Pushes run one at a time: a checkpoint never overlaps the last. */
  #pushing: Promise<void> = Promise.resolve();

  constructor(
    filesystem: Filesystem,
    mount: Mount,
    push: (options: { readonly settledBefore?: Date }) => Promise<void>,
  ) {
    this.#filesystem = filesystem;
    this.#mount = mount;
    this.#push = push;
    this.name = mount.name;
    this.mounted = {
      path: mount.path,
      permissions: {
        allow: [
          ...mount.read.map((glob) => `Read(/${mount.path}/${glob})`),
          ...mount.write.map((glob) => `Edit(/${mount.path}/${glob})`),
        ],
      },
    };
    const { checkpoints } = filesystem.options;
    if (checkpoints !== false) {
      this.#checkpoints = setInterval(() => {
        const settledBefore = new Date(
          Date.now() - checkpoints.settleSeconds * 1000,
        );
        this.#serialized({ settledBefore }).catch((error: unknown) => {
          // The push at the end is the one the outcome waits on.
          console.error(
            `filesystem "${this.name}": a checkpoint failed`,
            error,
          );
        });
      }, checkpoints.everySeconds * 1000);
    }
  }

  async unmount(ending: Ending): Promise<void> {
    clearInterval(this.#checkpoints);
    try {
      await this.#pushing.catch(() => undefined);
      const { push } = this.#filesystem.options;
      const pushes =
        (push === 'WHEN_COMPLETED' && ending === 'COMPLETED') ||
        (push === 'WHEN_ENDED' && ending !== 'CANCELED');
      if (pushes) {
        try {
          await this.#serialized({});
        } catch (error) {
          throw unsyncedOr(
            error,
            `filesystem "${this.name}" could not be pushed`,
          );
        }
      }
    } finally {
      await rm(this.#mount.path, { recursive: true, force: true });
    }
  }

  #serialized(options: { readonly settledBefore?: Date }): Promise<void> {
    this.#pushing = this.#pushing
      .catch(() => undefined)
      .then(() => this.#push(options));
    return this.#pushing;
  }
}

/** A store's failure becomes `FILESYSTEM_UNSYNCED`; anything else is the procedure's error, as it is. */
function unsyncedOr(error: unknown, what: string): unknown {
  if (!(error instanceof FilesystemUnsynced)) return error;
  return new TaskFailure(
    cause('FILESYSTEM_UNSYNCED', `${what}: ${error.message}`),
  );
}
