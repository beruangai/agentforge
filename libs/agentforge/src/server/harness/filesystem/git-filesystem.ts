import { createHash, randomUUIDv7 } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, matchesGlob, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AGENT_NAME_VARIABLE } from '#core/agent-name.ts';
import { cause } from '#core/contract/task.ts';
import {
  FILESYSTEM_NAME_PATTERN,
  FILESYSTEM_REPOSITORIES_VARIABLE,
  parseDeclared,
  parseRepositoryRemote,
} from '#core/filesystem.ts';
import { SecretNameSchema } from '#core/secrets.ts';
import { TaskFailure } from '../task-failure.ts';
import {
  Filesystem,
  type FilesystemOptions,
  type FilesystemRequest,
  FilesystemUnsynced,
  type Mount,
  type PushReport,
} from './filesystem.ts';
import { type ChildResult, runChild } from './run-child.ts';

export interface GitFilesystemOptions<Input = unknown>
  extends Omit<FilesystemOptions<Input>, 'checkpoints'> {
  /** Required: a git filesystem has no default local root. */
  readonly localRoot: string;
  /** The repository's name as the deployment declares it (`AGENTFORGE_FILESYSTEM_REPOSITORIES`). */
  readonly repository: string;
  /** The one branch its mounts pull and push; `main` when absent. */
  readonly branch?: string;
  /**
   * The environment variable of a declared secret holding the remote's
   * token, which an `https://` remote needs. It is removed from the
   * environment when the filesystem is constructed, and given to its git
   * operations alone; declare filesystems at module scope, so that happens
   * before any agent runs.
   */
  readonly tokenVariable?: string;
  /** A commit's message; `agentforge: <filesystem name>` when absent. Trailers naming the task are added either way. */
  readonly message?: (request: FilesystemRequest<Input>) => string;
  /** A commit's author and committer; the agent's name at `agentforge.invalid` when absent. */
  readonly author?: { readonly name: string; readonly email: string };
  /** Globs relative to the mount: never committed, pushed or deleted. */
  readonly exclude?: readonly string[];
  /** Off by default. When on, a push records a file removed from the write scope as deleted; never a file the base did not have. */
  readonly dangerouslyEnableDeletes?: boolean;
}

/** One git run, with its environment and working directory chosen by the kind. */
export type GitRunner = (
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
    readonly input?: string | undefined;
    readonly redact: (text: string) => string;
  },
) => Promise<ChildResult>;

/** The base image installs it on the `PATH` (libs/agentforge/Dockerfile). */
const GIT = 'git';
/** A git child runs at most this long, then is killed as unsynced. */
const GIT_TIMEOUT_SECONDS = 300;
/** How many times a push is tried against a moving branch. */
const PUSH_ATTEMPTS = 8;
const BACKOFF_MILLISECONDS = { minimum: 250, maximum: 5_000 } as const;
/** git's tree with nothing in it, known to every repository. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BASE_REF = 'refs/agentforge/base';
const TIP_REF = 'refs/agentforge/tip';
/** Where each local directory's private clone lives: never inside a mount. */
const PRIVATE_ROOT = join(tmpdir(), 'agentforge-git');

/** Runs git as a child of the task process, bounded, with no shell. */
export const runGit: GitRunner = (args, options) =>
  runChild({
    command: GIT,
    args,
    env: options.env,
    cwd: options.cwd,
    input: options.input,
    captureStdout: true,
    timeoutSeconds: GIT_TIMEOUT_SECONDS,
    redact: options.redact,
    missing:
      "git filesystems run in AgentForge's base image, which installs it",
  });

/**
 * Tokens taken out of the environment, by the variable that held them: a
 * second filesystem naming the same variable finds it here, since the first
 * removed it.
 */
const TOKENS = new Map<string, string>();

/** A branch name git would accept, simplified: no control or special characters, no `..`, `@{`, `//`, and no leading `-` or `/`. */
const BRANCH_PATTERN =
  /^(?![-/])(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock$|\/$|\.$))[^\0-\x20~^:?*[\\\x7f]+$/;

/** A remote refused the request's credential, or asked for one it did not get. */
const CREDENTIAL_REFUSED =
  /Authentication failed|HTTP 40[13]|The requested URL returned error: 40[13]|could not read Username|could not read Password|terminal prompts disabled|Invalid username or password/i;

/** The branch moved, or a ref was locked, under the push: retrying may succeed. */
const CONTENDED =
  /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|failed to update ref|cannot lock ref|Unable to create '.*\.lock'|incorrect old value/i;

/** Whether a failed git run's stderr says the remote refused its credential. */
export function isCredentialRefusal(stderr: string): boolean {
  return CREDENTIAL_REFUSED.test(stderr);
}

/** Whether a failed push may succeed when retried against the new tip. */
export function isContended(result: ChildResult): boolean {
  return result.timedOut || CONTENDED.test(result.stderr);
}

/** A full-jitter backoff for the attempt (1-based), within the bounds. */
export function backoffMilliseconds(
  attempt: number,
  random = Math.random,
): number {
  const ceiling = Math.min(
    BACKOFF_MILLISECONDS.maximum,
    BACKOFF_MILLISECONDS.minimum * 2 ** (attempt - 1),
  );
  return (
    BACKOFF_MILLISECONDS.minimum +
    random() * (ceiling - BACKOFF_MILLISECONDS.minimum)
  );
}

/** Replaces every secret in the text with `***`. */
export function redactor(secrets: readonly string[]): (text: string) => string {
  const present = secrets.filter((secret) => secret !== '');
  return (text) =>
    present.reduce(
      (redacted, secret) => redacted.split(secret).join('***'),
      text,
    );
}

/** The files of a mount's work tree that changed against its index. */
export interface LocalChanges {
  /** Changed or added: modified tracked files, and untracked ones. */
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
}

/**
 * What a push records of the local changes: the files a write glob matches
 * and no `exclude` glob does, and deletions only when the filesystem
 * deletes.
 */
export function selectChanges(
  changes: LocalChanges,
  scope: {
    readonly write: readonly string[];
    readonly exclude: readonly string[];
    readonly deletes: boolean;
  },
): {
  readonly changed: readonly string[];
  readonly deleted: readonly string[];
} {
  const kept = (path: string) =>
    scope.write.some((glob) => matchesGlob(path, glob)) &&
    !scope.exclude.some((glob) => matchesGlob(path, glob));
  return {
    changed: changes.changed.filter(kept),
    deleted: scope.deletes ? changes.deleted.filter(kept) : [],
  };
}

/** NUL-separated output as its entries. */
function entries(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/**
 * A subtree of one branch of a git repository, mounted without a checkout:
 * a private blobless clone beside the mount, whose subtree is read into the
 * mount with an index of its own. A push commits the write scope's changes
 * onto the base it pulled, merges onto a moved tip in memory, and refuses
 * a file both writers changed (ADR 0024).
 */
export class GitFilesystem<in Input = unknown> extends Filesystem<Input> {
  readonly #gitOptions: {
    readonly repository: string;
    readonly branch: string;
    readonly tokenVariable: string | undefined;
    readonly message:
      | ((request: FilesystemRequest<Input>) => string)
      | undefined;
    readonly author:
      | { readonly name: string; readonly email: string }
      | undefined;
    readonly exclude: readonly string[];
    readonly dangerouslyEnableDeletes: boolean;
  };
  readonly #git: GitRunner;
  readonly #environment: NodeJS.ProcessEnv;
  #declaredRepositories: Readonly<Record<string, string>> | undefined;

  constructor(
    options: GitFilesystemOptions<Input>,
    /** Test seams. */
    seams: {
      readonly git?: GitRunner;
      readonly environment?: NodeJS.ProcessEnv;
    } = {},
  ) {
    if ('checkpoints' in options) {
      throw new Error(
        'GitFilesystem has no checkpoints: each would be a commit the agent did not choose; it offers the agent a push when pushOn includes TASK_STATE_FAILED',
      );
    }
    const {
      repository,
      branch = 'main',
      tokenVariable,
      message,
      author,
      exclude = [],
      dangerouslyEnableDeletes = false,
      ...filesystemOptions
    } = options;
    super(filesystemOptions, { deletes: dangerouslyEnableDeletes });
    if (!FILESYSTEM_NAME_PATTERN.test(repository)) {
      throw new Error(
        `repository "${repository}" must match ${FILESYSTEM_NAME_PATTERN}`,
      );
    }
    if (!BRANCH_PATTERN.test(branch)) {
      throw new Error(`branch "${branch}" is not a valid branch name`);
    }
    if (
      tokenVariable !== undefined &&
      !SecretNameSchema.safeParse(tokenVariable).success
    ) {
      throw new Error(
        `tokenVariable "${tokenVariable}" is not an environment variable name`,
      );
    }
    this.#environment = seams.environment ?? process.env;
    if (tokenVariable !== undefined) {
      const token = this.#environment[tokenVariable];
      if (token !== undefined) {
        TOKENS.set(tokenVariable, token);
        // Before any agent runs: a run, and any child started with the
        // current environment, inherits what is left.
        delete this.#environment[tokenVariable];
      }
    }
    this.#gitOptions = {
      repository,
      branch,
      tokenVariable,
      message,
      author,
      exclude,
      dangerouslyEnableDeletes,
    };
    this.#git = seams.git ?? runGit;
  }

  protected override validate(mount: Mount): void {
    const remote = this.#remote();
    if (remote.protocol === 'https:' && this.#token() === undefined) {
      const variable = this.#gitOptions.tokenVariable;
      throw new Error(
        variable === undefined
          ? `filesystem "${mount.name}": repository "${this.#gitOptions.repository}" is an https:// remote, which needs a tokenVariable naming its token's secret`
          : `filesystem "${mount.name}": ${variable} is not set; repository "${this.#gitOptions.repository}" is an https:// remote, which needs its token`,
      );
    }
    if (this.#gitOptions.dangerouslyEnableDeletes && mount.remotePath === '/') {
      throw new Error(
        `filesystem "${mount.name}": dangerouslyEnableDeletes needs a remote root or subpath, since on the whole repository it could empty it`,
      );
    }
    this.#author();
  }

  /** The repository's location, and the branch. */
  protected storeIdentity(): string {
    return `${this.#remote().href}#${this.#gitOptions.branch}`;
  }

  protected override privatePaths(mount: Mount): readonly string[] {
    return [privateDirectory(mount)];
  }

  protected async pull(mount: Mount): Promise<void> {
    const git = this.#mountGit(mount);
    await this.#ensureClone(mount);
    await removeStaleLocks(git.directory);
    const tip = await this.#fetchTip(git);
    const base = await git.resolve(BASE_REF);
    if (base === undefined) {
      // Nothing recorded yet: the index matches nothing, so every local file is a change.
      await git.inMount(['read-tree', '--empty']);
    }
    await this.#advanceTo(mount, git, base, tip);
  }

  protected async push(
    mount: Mount,
    options: { readonly modifiedBefore?: Date },
  ): Promise<void> {
    if (options.modifiedBefore !== undefined) {
      throw new Error('GitFilesystem has no checkpoints');
    }
    await this.#push(mount, this.#defaultMessage(mount));
  }

  protected override agentPush(
    mount: Mount,
    message: string,
  ): Promise<PushReport> {
    return this.#push(mount, message);
  }

  async #push(mount: Mount, message: string): Promise<PushReport> {
    const git = this.#mountGit(mount);
    const selected = selectChanges(await localChanges(git), {
      write: mount.write,
      exclude: this.#gitOptions.exclude,
      deletes: this.#gitOptions.dangerouslyEnableDeletes,
    });
    const files = [...selected.changed, ...selected.deleted];
    if (files.length === 0) return { files: [] };
    let base = await git.resolve(BASE_REF);
    const prefix = repositoryPath(mount);
    // The mount's subtree with the selected files, in a copy of its index.
    const pushIndex = join(git.directory, 'push.index');
    await copyFile(join(git.directory, 'mount.index'), pushIndex);
    await git.inMount(['update-index', '--add', '--remove', '-z', '--stdin'], {
      index: pushIndex,
      input: files.map((file) => `${file}\0`).join(''),
    });
    const subtree = await git.inMount(['write-tree'], { index: pushIndex });
    const tree = await this.#splice(git, base, prefix, subtree);
    if (
      base !== undefined &&
      tree === (await git.inRepository(['rev-parse', `${base}^{tree}`]))
    ) {
      return { files: [] };
    }
    const fullMessage = withTrailers(message, mount);
    const ours = await this.#commit(git, tree, base, fullMessage);
    let candidate = ours;
    for (let attempt = 1; ; attempt += 1) {
      const pushed = await git.run(
        [
          'push',
          '--quiet',
          'origin',
          `${candidate}:refs/heads/${this.#gitOptions.branch}`,
        ],
        { cwd: git.directory, env: git.repositoryEnv },
      );
      if (pushed.exitCode === 0) break;
      this.#refuseCredential(pushed);
      if (!isContended(pushed)) {
        throw new FilesystemUnsynced(
          `git push exited ${pushed.exitCode}: ${pushed.stderr.trim()}`,
        );
      }
      if (attempt === PUSH_ATTEMPTS) {
        throw new FilesystemUnsynced(
          `the branch kept moving: ${PUSH_ATTEMPTS} attempts to push were rejected; last: ${pushed.stderr.trim()}`,
        );
      }
      await sleep(backoffMilliseconds(attempt));
      const tip = await this.#fetchTip(git);
      if (tip === undefined) {
        throw new FilesystemUnsynced(
          `branch ${this.#gitOptions.branch} is gone from the remote`,
        );
      }
      if (base === undefined) {
        throw new FilesystemUnsynced(
          `branch ${this.#gitOptions.branch} was created by another writer since the pull; a retry pulls it`,
        );
      }
      if (tip === base) continue;
      const theirs = await changedPaths(git, base, tip, '');
      const mine = new Set(await changedPaths(git, base, ours, ''));
      const shared = theirs.filter((path) => mine.has(path));
      if (shared.length > 0) {
        throw new FilesystemUnsynced(
          `another writer changed ${shared.map((path) => relativeToMount(path, prefix)).join(', ')} on ${this.#gitOptions.branch} since the pull`,
        );
      }
      const merged = await git.run(
        ['merge-tree', '--write-tree', `--merge-base=${base}`, tip, candidate],
        { cwd: git.directory, env: git.repositoryEnv },
      );
      if (merged.exitCode !== 0) {
        throw new FilesystemUnsynced(
          `the push could not be merged onto ${this.#gitOptions.branch}: ${merged.stdout.trim() || merged.stderr.trim()}`,
        );
      }
      const [mergedTree = ''] = merged.stdout.split('\n');
      candidate = await this.#commit(git, mergedTree.trim(), tip, fullMessage);
      base = tip;
    }
    // The pushed files are now the base's: recorded in the mount's index, so
    // advancing never reports them as discarded.
    await git.inMount(['update-index', '--add', '--remove', '-z', '--stdin'], {
      input: files.map((file) => `${file}\0`).join(''),
    });
    await this.#advanceTo(mount, git, ours, candidate);
    return { commit: candidate, files };
  }

  /** The repository's tree with `subtree` at `prefix`, over the base's. */
  async #splice(
    git: MountGit,
    base: string | undefined,
    prefix: string,
    subtree: string,
  ): Promise<string> {
    if (prefix === '') return subtree;
    const spliceIndex = join(git.directory, 'splice.index');
    const options = { index: spliceIndex };
    await git.inMount(['read-tree', base ?? EMPTY_TREE], options);
    const replaced = await git.inMount(
      ['ls-files', '-z', '--', prefix],
      options,
    );
    if (replaced !== '') {
      await git.inMount(['update-index', '--force-remove', '-z', '--stdin'], {
        ...options,
        input: replaced.endsWith('\0') ? replaced : `${replaced}\0`,
      });
    }
    await git.inMount(['read-tree', `--prefix=${prefix}/`, subtree], options);
    return git.inMount(['write-tree'], options);
  }

  async #commit(
    git: MountGit,
    tree: string,
    parent: string | undefined,
    message: string,
  ): Promise<string> {
    const author = this.#author();
    return git.inRepository(
      [
        'commit-tree',
        tree,
        ...(parent === undefined ? [] : ['-p', parent]),
        '-F',
        '-',
      ],
      {
        input: message,
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email,
        },
      },
    );
  }

  /**
   * Brings the mount from `from` — the commit its index matches — to
   * `target`: local changes the store did not make are kept, a local
   * change to a file the store changed is discarded and logged, and a
   * local deletion is undone.
   */
  async #advanceTo(
    mount: Mount,
    git: MountGit,
    from: string | undefined,
    target: string | undefined,
  ): Promise<void> {
    const prefix = repositoryPath(mount);
    const local = await localChanges(git);
    const upstream = new Set(
      target === undefined || target === from
        ? []
        : (await changedPaths(git, from ?? EMPTY_TREE, target, prefix)).map(
            (path) => relativeToMount(path, prefix),
          ),
    );
    const kept = local.changed.filter((path) => !upstream.has(path));
    for (const path of local.changed.filter((path) => upstream.has(path))) {
      console.warn(
        `filesystem "${mount.name}": discarded the local change to ${path}, which ${this.#gitOptions.branch} changed since the copy's base`,
      );
    }
    const backup = join(git.directory, `backup-${randomUUIDv7()}`);
    for (const path of kept) {
      await mkdir(dirname(join(backup, path)), { recursive: true });
      await cp(join(mount.localPath, path), join(backup, path));
    }
    const subtree =
      target === undefined ? EMPTY_TREE : await subtreeOf(git, target, prefix);
    await git.inMount(['read-tree', '-u', '--reset', subtree]);
    for (const path of kept) {
      await mkdir(dirname(join(mount.localPath, path)), { recursive: true });
      await cp(join(backup, path), join(mount.localPath, path));
    }
    await rm(backup, { recursive: true, force: true });
    if (target === undefined) {
      await git.inRepository(['update-ref', '-d', BASE_REF]);
    } else {
      await git.inRepository(['update-ref', BASE_REF, target]);
    }
  }

  async #ensureClone(mount: Mount): Promise<void> {
    const directory = privateDirectory(mount);
    if (existsSync(directory)) return;
    const parent = dirname(directory);
    await mkdir(parent, { recursive: true });
    // A clone a killed task left half-made; the claim means no live task owns it.
    for (const entry of await readdir(parent)) {
      if (entry.startsWith(`${directory.slice(parent.length + 1)}.cloning-`)) {
        await rm(join(parent, entry), { recursive: true, force: true });
      }
    }
    const cloning = `${directory}.cloning-${randomUUIDv7()}`;
    const result = await this.#git(
      [
        'clone',
        '--bare',
        '--quiet',
        '--filter=blob:none',
        '--no-tags',
        this.#remote().href,
        cloning,
      ],
      { cwd: parent, env: this.#gitEnvironment(), redact: this.#redact() },
    );
    if (result.exitCode !== 0) {
      await rm(cloning, { recursive: true, force: true });
      this.#refuseCredential(result);
      throw new FilesystemUnsynced(
        `git clone exited ${result.exitCode}: ${result.stderr.trim()}`,
      );
    }
    await rename(cloning, directory);
  }

  /** The branch's tip, fetched into the clone; undefined while the branch does not exist. */
  async #fetchTip(git: MountGit): Promise<string | undefined> {
    const branchRef = `refs/heads/${this.#gitOptions.branch}`;
    const listed = await git.run(['ls-remote', 'origin', branchRef], {
      cwd: git.directory,
      env: git.repositoryEnv,
    });
    if (listed.exitCode !== 0) {
      this.#refuseCredential(listed);
      throw new FilesystemUnsynced(
        `git ls-remote exited ${listed.exitCode}: ${listed.stderr.trim()}`,
      );
    }
    const line = listed.stdout
      .split('\n')
      .find((each) => each.endsWith(`\t${branchRef}`));
    if (line === undefined) return undefined;
    const fetched = await git.run(
      [
        'fetch',
        '--quiet',
        '--no-tags',
        '--filter=blob:none',
        'origin',
        `+${branchRef}:${TIP_REF}`,
      ],
      { cwd: git.directory, env: git.repositoryEnv },
    );
    if (fetched.exitCode !== 0) {
      this.#refuseCredential(fetched);
      throw new FilesystemUnsynced(
        `git fetch exited ${fetched.exitCode}: ${fetched.stderr.trim()}`,
      );
    }
    return git.inRepository(['rev-parse', '--verify', `${TIP_REF}^{commit}`]);
  }

  /** A remote that refused the credential fails the task for an operator, never as retryable. */
  #refuseCredential(result: ChildResult): void {
    if (!isCredentialRefusal(result.stderr)) return;
    const variable = this.#gitOptions.tokenVariable;
    throw new TaskFailure(
      cause(
        'CREDENTIAL_EXPIRED',
        `repository "${this.#gitOptions.repository}" refused its credential${variable === undefined ? '' : `, ${variable}`}: ${result.stderr.trim()}`,
      ),
    );
  }

  #mountGit(mount: Mount): MountGit {
    const directory = privateDirectory(mount);
    const repositoryEnv = { ...this.#gitEnvironment(), GIT_DIR: directory };
    const mountEnv = {
      ...repositoryEnv,
      GIT_WORK_TREE: mount.localPath,
      GIT_INDEX_FILE: join(directory, 'mount.index'),
    };
    const redact = this.#redact();
    const run = (
      args: readonly string[],
      options: {
        readonly cwd: string;
        readonly env: NodeJS.ProcessEnv;
        readonly input?: string | undefined;
      },
    ) => this.#git(args, { ...options, redact });
    const succeed = async (
      args: readonly string[],
      options: {
        readonly cwd: string;
        readonly env: NodeJS.ProcessEnv;
        readonly input?: string | undefined;
      },
    ) => {
      const result = await run(args, options);
      if (result.exitCode !== 0) {
        this.#refuseCredential(result);
        throw new FilesystemUnsynced(
          `git ${args[0]} exited ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}: ${result.stderr.trim()}`,
        );
      }
      return result.stdout.trim();
    };
    return {
      directory,
      repositoryEnv,
      mountDirectory: mount.localPath,
      mountEnv,
      run,
      inRepository: (args, options = {}) =>
        succeed(args, {
          cwd: directory,
          env: { ...repositoryEnv, ...options.env },
          input: options.input,
        }),
      inMount: (args, options = {}) =>
        succeed(args, {
          cwd: mount.localPath,
          env:
            options.index === undefined
              ? mountEnv
              : { ...mountEnv, GIT_INDEX_FILE: options.index },
          input: options.input,
        }),
      resolve: async (ref) => {
        const result = await run(
          ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
          {
            cwd: directory,
            env: repositoryEnv,
          },
        );
        return result.exitCode === 0 ? result.stdout.trim() : undefined;
      },
    };
  }

  /**
   * Every git child's environment: the task process's, with nothing ambient
   * from git's own configuration, no prompt, any repository trusted, and the
   * token, when there is one, as an extra header for its host alone.
   */
  #gitEnvironment(): NodeJS.ProcessEnv {
    const config: [string, string][] = [['safe.directory', '*']];
    const remote = this.#remote();
    const token = this.#token();
    if (remote.protocol === 'https:' && token !== undefined) {
      config.push([
        `http.https://${remote.host}/.extraheader`,
        `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
      ]);
    }
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
    );
    return {
      ...inherited,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_COUNT: String(config.length),
      ...Object.fromEntries(
        config.flatMap(([key, value], index) => [
          [`GIT_CONFIG_KEY_${index}`, key],
          [`GIT_CONFIG_VALUE_${index}`, value],
        ]),
      ),
    };
  }

  #redact(): (text: string) => string {
    const token = this.#token();
    return token === undefined
      ? (text) => text
      : redactor([
          token,
          Buffer.from(`x-access-token:${token}`).toString('base64'),
        ]);
  }

  #token(): string | undefined {
    const variable = this.#gitOptions.tokenVariable;
    return variable === undefined ? undefined : TOKENS.get(variable);
  }

  #remote(): URL {
    this.#declaredRepositories ??= parseDeclared(
      FILESYSTEM_REPOSITORIES_VARIABLE,
      this.#environment[FILESYSTEM_REPOSITORIES_VARIABLE],
    );
    const declared = this.#declaredRepositories;
    const location = declared[this.#gitOptions.repository];
    if (location === undefined) {
      throw new Error(
        `no repository "${this.#gitOptions.repository}" is declared to this agent; declared: ${Object.keys(declared).join(', ') || 'none'}`,
      );
    }
    return parseRepositoryRemote(
      `repository "${this.#gitOptions.repository}"`,
      location,
      ['https:', 'file:'],
    );
  }

  #author(): { readonly name: string; readonly email: string } {
    if (this.#gitOptions.author !== undefined) return this.#gitOptions.author;
    const agent = this.#environment[AGENT_NAME_VARIABLE];
    if (agent === undefined || agent === '') {
      throw new Error(
        `GitFilesystem needs an author: declare one, or run where ${AGENT_NAME_VARIABLE} names the agent`,
      );
    }
    return { name: agent, email: `${agent}@agentforge.invalid` };
  }

  #defaultMessage(mount: Mount): string {
    return (
      // Resolved by this filesystem, from a request of its own input.
      this.#gitOptions.message?.(mount.request as FilesystemRequest<Input>) ??
      `agentforge: ${mount.name}`
    );
  }
}

/** The git operations on one mount's private clone and work tree. */
interface MountGit {
  readonly directory: string;
  readonly repositoryEnv: NodeJS.ProcessEnv;
  readonly mountDirectory: string;
  readonly mountEnv: NodeJS.ProcessEnv;
  readonly run: (
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: NodeJS.ProcessEnv;
      readonly input?: string | undefined;
    },
  ) => Promise<ChildResult>;
  /** In the clone, as a bare repository; throws unless it succeeds, returning trimmed stdout. */
  readonly inRepository: (
    args: readonly string[],
    options?: {
      readonly input?: string | undefined;
      readonly env?: NodeJS.ProcessEnv;
    },
  ) => Promise<string>;
  /** In the mount's work tree, with its index or the one given; throws unless it succeeds. */
  readonly inMount: (
    args: readonly string[],
    options?: { readonly input?: string | undefined; readonly index?: string },
  ) => Promise<string>;
  /** A ref's commit, or undefined when it does not exist. */
  readonly resolve: (ref: string) => Promise<string | undefined>;
}

/** The private clone of a local directory. */
function privateDirectory(mount: Mount): string {
  const digest = createHash('sha256')
    .update(resolve(mount.localPath))
    .digest('hex');
  return join(PRIVATE_ROOT, digest);
}

/** The mount's remote path as a path in the repository: `''` for its root. */
function repositoryPath(mount: Mount): string {
  return mount.remotePath.replace(/^\/+/, '').replace(/\/+$/, '');
}

function relativeToMount(path: string, prefix: string): string {
  return prefix === '' ? path : path.slice(prefix.length + 1);
}

/** The tree at `prefix` in a commit; the empty tree where the commit has no such directory. */
async function subtreeOf(
  git: MountGit,
  commit: string,
  prefix: string,
): Promise<string> {
  if (prefix === '') return git.inRepository(['rev-parse', `${commit}^{tree}`]);
  const result = await git.run(
    ['rev-parse', '--verify', '--quiet', `${commit}:${prefix}`],
    {
      cwd: git.directory,
      env: git.repositoryEnv,
    },
  );
  if (result.exitCode !== 0) return EMPTY_TREE;
  const tree = result.stdout.trim();
  const type = await git.inRepository(['cat-file', '-t', tree]);
  return type === 'tree' ? tree : EMPTY_TREE;
}

/** The repository paths that differ between two tree-ishes, under `prefix`. */
async function changedPaths(
  git: MountGit,
  from: string,
  to: string,
  prefix: string,
): Promise<string[]> {
  return entries(
    await git.inRepository([
      'diff-tree',
      '-r',
      '-z',
      '--name-only',
      '--no-renames',
      from,
      to,
      ...(prefix === '' ? [] : ['--', prefix]),
    ]),
  );
}

/** The work tree's changes against the mount's index: modified, added and deleted files. */
async function localChanges(git: MountGit): Promise<LocalChanges> {
  // A file whose stat changed but whose content did not is no change. It
  // exits 1 when files need updating, which diff-files then reports.
  const refreshed = await git.run(['update-index', '-q', '--refresh'], {
    cwd: git.mountDirectory,
    env: git.mountEnv,
  });
  if (refreshed.exitCode !== 0 && refreshed.exitCode !== 1) {
    throw new FilesystemUnsynced(
      `git update-index exited ${refreshed.exitCode}: ${refreshed.stderr.trim()}`,
    );
  }
  const status = entries(
    await git.inMount(['diff-files', '-z', '--name-status']),
  );
  const changed: string[] = [];
  const deleted: string[] = [];
  for (let index = 0; index + 1 < status.length; index += 2) {
    const [code, path] = [status[index], status[index + 1]] as [string, string];
    (code === 'D' ? deleted : changed).push(path);
  }
  const untracked = entries(await git.inMount(['ls-files', '--others', '-z']));
  return { changed: [...changed, ...untracked], deleted };
}

/** Every lock a killed git child left in the clone; the claim means no live task holds one. */
async function removeStaleLocks(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { recursive: true })) {
    if (entry.endsWith('.lock'))
      await rm(join(directory, entry), { force: true });
  }
}

/** The message with trailers naming the task. */
function withTrailers(message: string, mount: Mount): string {
  const { context } = mount.request;
  return `${message.trimEnd()}\n\nAgentForge-Task-Id: ${mount.taskId}\nAgentForge-Idempotency-Key: ${context.idempotencyKey}\nAgentForge-Attempt: ${context.attempt}\n`;
}
