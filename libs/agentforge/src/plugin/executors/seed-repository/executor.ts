import { spawnSync } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { parseEnv } from 'node:util';
import type { ExecutorContext } from '@nx/devkit';
import { getEnvPathsForTask } from 'nx/src/devkit-internals';
import {
  FILESYSTEM_NAME_PATTERN,
  FILESYSTEM_REPOSITORIES_VARIABLE,
  parseDeclared,
  parseRepositoryRemote,
} from '#core/filesystem.ts';
import { isAgenticProject, isWorkflowProject } from '../../project-record.ts';
import {
  allowPartialClones,
  configValue,
  hostGit,
  hostPathKind,
} from './host-repository.ts';

export interface SeedRepositoryExecutorOptions {
  /** The name `AGENTFORGE_FILESYSTEM_REPOSITORIES` and a git filesystem's `repository` use. */
  readonly repository: string;
  /** The remote to clone, `https://` with no credential in it. */
  readonly remote: string;
  /** Where the host repository lives, absolute or relative to the workspace; `.agentforge/repositories/<repository>.git` by default. */
  readonly location?: string;
  /** A working clone to point at the host repository, cloned from it when absent. */
  readonly readingClone?: string;
}

/** The workspace's env files a declaration is written to: committed for a relative location, local for an absolute one. */
const SERVE_ENV_FILE = '.env.serve';
const SERVE_LOCAL_ENV_FILE = '.env.serve.local';

export function defaultLocation(repository: string): string {
  return join('.agentforge', 'repositories', `${repository}.git`);
}

/** A remote URL as two spellings of one remote compare: without a trailing `/` or `.git`. */
export function sameRemote(left: string, right: string): boolean {
  const normal = (url: string) =>
    url
      .replace(/\/+$/, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
  return normal(left) === normal(right);
}

/** A task that serves locally, by its project's root, target and configuration: whose env files a declaration must reach. */
export interface ServeTask {
  readonly project: string;
  readonly projectRoot: string;
  readonly target: string;
  readonly configuration: string | undefined;
}

/**
 * Every serve task of the workspace's agentic and workflow projects, in each
 * configuration it runs under: Nx runs a target with a default configuration
 * under it, never without one.
 */
export function serveTasks(context: ExecutorContext): readonly ServeTask[] {
  return Object.entries(context.projectsConfigurations.projects).flatMap(
    ([project, configuration]) => {
      const serves = Object.entries(configuration.targets ?? {}).filter(
        ([target, definition]) =>
          isAgenticProject(configuration)
            ? definition.executor === '@beruangai/agentforge:serve'
            : isWorkflowProject(configuration) && target === 'serve',
      );
      return serves.flatMap(([target, definition]) =>
        [
          ...new Set([
            definition.defaultConfiguration,
            ...Object.keys(definition.configurations ?? {}),
          ]),
        ].map((configurationName) => ({
          project,
          projectRoot: configuration.root,
          target,
          configuration: configurationName,
        })),
      );
    },
  );
}

/** A file's content, from what this run will write when it writes it, else from disk; undefined when absent. */
type Contents = (file: string) => string | undefined;

/** The env file, relative to the workspace, whose definition of the variable a task loads, and that definition; undefined when none defines it. */
export function effectiveDeclaration(
  task: ServeTask,
  contents: Contents,
): { readonly file: string; readonly value: string } | undefined {
  // Nx loads the project's files and then the workspace's, and the first
  // definition of a variable wins.
  for (const file of getEnvPathsForTask(
    task.projectRoot,
    task.target,
    task.configuration,
  )) {
    const content = contents(file);
    if (content === undefined) continue;
    const value = parseEnv(content)[FILESYSTEM_REPOSITORIES_VARIABLE];
    if (value !== undefined) return { file, value };
  }
  return undefined;
}

/** Fails, naming the task and the file, unless every task would see `repository` declared at `location`. */
export function checkEveryTaskSees(
  tasks: readonly ServeTask[],
  contents: Contents,
  repository: string,
  location: string,
  sameLocation: (left: string, right: string) => boolean,
): void {
  for (const task of tasks) {
    const effective = effectiveDeclaration(task, contents);
    const seen =
      effective === undefined
        ? undefined
        : parseDeclared(
            `${FILESYSTEM_REPOSITORIES_VARIABLE} in ${effective.file}`,
            effective.value,
          )[repository];
    if (seen === undefined || !sameLocation(seen, location)) {
      throw new Error(
        `${task.project}:${task.target}${task.configuration === undefined ? '' : `:${task.configuration}`} would not see repository "${repository}" at ${location}: ${effective?.file ?? 'no file'} defines ${FILESYSTEM_REPOSITORIES_VARIABLE} ${seen === undefined ? 'without it' : `with it at ${seen}`}; declare it there too, or declare repositories only at the workspace root`,
      );
    }
  }
}

const DECLARATION_LINE = new RegExp(
  `^\\s*(?:export\\s+)?${FILESYSTEM_REPOSITORIES_VARIABLE}\\s*=`,
);

/**
 * The env file's content with `repository` declared at `location`, merged
 * into the variable's JSON; the content unchanged when it already declares
 * it there. Fails on an entry naming another location, or a variable
 * defined twice in the file.
 */
export function withDeclaration(
  content: string,
  file: string,
  repository: string,
  location: string,
  sameLocation: (left: string, right: string) => boolean,
): string {
  const lines = content === '' ? [] : content.split('\n');
  const indices = lines.flatMap((line, index) =>
    DECLARATION_LINE.test(line) ? [index] : [],
  );
  if (indices.length > 1) {
    throw new Error(
      `${file} defines ${FILESYSTEM_REPOSITORIES_VARIABLE} ${indices.length} times; keep one`,
    );
  }
  const declared = parseDeclared(
    `${FILESYSTEM_REPOSITORIES_VARIABLE} in ${file}`,
    parseEnv(content)[FILESYSTEM_REPOSITORIES_VARIABLE],
  );
  const existing = declared[repository];
  if (existing !== undefined) {
    if (sameLocation(existing, location)) return content;
    throw new Error(
      `${file} declares repository "${repository}" at ${existing}, not ${location}; change it there to seed another location`,
    );
  }
  const line = `${FILESYSTEM_REPOSITORIES_VARIABLE}=${JSON.stringify({
    ...declared,
    [repository]: location,
  })}`;
  const [index] = indices;
  if (index === undefined) {
    const kept = lines.at(-1) === '' ? lines.slice(0, -1) : lines;
    return `${[...kept, line].join('\n')}\n`;
  }
  return lines.map((each, at) => (at === index ? line : each)).join('\n');
}

/** Whether git's ignore rules keep `path` out of the workspace's version control; true when the workspace is not a git work tree. */
function ignoredByGit(workspaceRoot: string, path: string): boolean {
  const result = spawnSync('git', ['check-ignore', '--quiet', path], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  // 128: the workspace is not a git work tree, so there is nothing to keep it out of.
  if (/not a git repository/.test(result.stderr)) return true;
  throw new Error(`git check-ignore ${path} failed: ${result.stderr.trim()}`);
}

/** Every commit reachable from any ref of the repository at `path`. */
function commits(path: string): Set<string> {
  return new Set(
    hostGit(['rev-list', '--all'], { cwd: path }).split('\n').filter(Boolean),
  );
}

/**
 * Seeds a declared repository's host repository from its remote: a bare
 * clone at the location, able to serve a partial clone, declared in the
 * workspace root's env files for every project's serve. Adopts a bare
 * clone of the same remote; points a reading clone at it. Writes nothing
 * to the remote, never deletes or overwrites, and changes nothing when run
 * again. Everything it would refuse is checked before anything is written.
 */
export function seedRepository(
  options: SeedRepositoryExecutorOptions,
  workspaceRoot: string,
  tasks: readonly ServeTask[],
  log: (line: string) => void = console.log,
): void {
  const { repository, remote } = options;
  if (!FILESYSTEM_NAME_PATTERN.test(repository)) {
    throw new Error(
      `repository "${repository}" must match ${FILESYSTEM_NAME_PATTERN}`,
    );
  }
  parseRepositoryRemote(`the remote of repository "${repository}"`, remote, [
    'https:',
  ]);
  const location = options.location ?? defaultLocation(repository);
  const absolute = (path: string) => resolve(workspaceRoot, path);
  const hostPath = absolute(location);
  const sameLocation = (left: string, right: string) =>
    absolute(left) === absolute(right);

  // Checked before anything is written.
  const kind = hostPathKind(hostPath);
  if (kind === 'working' || kind === 'other') {
    throw new Error(
      `${hostPath} is ${kind === 'working' ? 'a working clone' : 'not a bare repository'}; seed-repository creates or adopts only a bare repository there`,
    );
  }
  if (kind === 'bare') {
    const origin = configValue(hostPath, 'remote.origin.url');
    if (origin === undefined || !sameRemote(origin, remote)) {
      throw new Error(
        `${hostPath} is a bare repository of ${origin === undefined ? 'no remote' : `another remote, ${origin}`}, not ${remote}`,
      );
    }
  }
  const readingClone =
    options.readingClone === undefined
      ? undefined
      : absolute(options.readingClone);
  if (readingClone !== undefined) {
    const readingKind = hostPathKind(readingClone);
    if (readingKind !== 'absent' && readingKind !== 'working') {
      throw new Error(
        `${readingClone} is not a working clone; the reading clone must be one, or absent`,
      );
    }
  }
  const envFile = isAbsolute(location) ? SERVE_LOCAL_ENV_FILE : SERVE_ENV_FILE;
  const envPath = join(workspaceRoot, envFile);
  const before = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const declared = withDeclaration(
    before,
    envFile,
    repository,
    location,
    sameLocation,
  );
  const contents: Contents = (file) => {
    if (file === envFile) return declared;
    const path = join(workspaceRoot, file);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  };
  checkEveryTaskSees(tasks, contents, repository, location, sameLocation);

  if (kind === 'absent') {
    const parent = dirname(hostPath);
    mkdirSync(parent, { recursive: true });
    const seeding = join(
      parent,
      `.${basename(hostPath)}.seeding-${randomUUIDv7()}`,
    );
    try {
      hostGit(['clone', '--bare', remote, seeding], { inheritOutput: true });
      allowPartialClones(seeding);
      renameSync(seeding, hostPath);
    } catch (error) {
      rmSync(seeding, { recursive: true, force: true });
      throw error;
    }
    log(`Cloned ${remote} into ${hostPath}`);
  } else if (configValue(hostPath, 'uploadpack.allowFilter') !== 'true') {
    allowPartialClones(hostPath);
    log(`Adopted ${hostPath}, enabling partial clones`);
  }

  const inWorkspace = relative(workspaceRoot, hostPath);
  if (
    !inWorkspace.startsWith('..') &&
    !isAbsolute(inWorkspace) &&
    !ignoredByGit(workspaceRoot, inWorkspace)
  ) {
    const gitignore = join(workspaceRoot, '.gitignore');
    const existing = existsSync(gitignore)
      ? readFileSync(gitignore, 'utf8')
      : '';
    appendFileSync(
      gitignore,
      `${existing === '' || existing.endsWith('\n') ? '' : '\n'}/${inWorkspace}/\n`,
    );
    log(`Ignored /${inWorkspace}/ in .gitignore`);
  }

  if (declared !== before) {
    writeFileSync(envPath, declared);
    log(`Declared repository "${repository}" at ${location} in ${envFile}`);
  }

  if (readingClone !== undefined) {
    if (!existsSync(readingClone)) {
      hostGit(['clone', hostPath, readingClone], { inheritOutput: true });
      log(`Cloned ${hostPath} into the reading clone ${readingClone}`);
    } else {
      const host = commits(hostPath);
      if (![...commits(readingClone)].some((commit) => host.has(commit))) {
        throw new Error(
          `${readingClone} shares no commit with ${hostPath}; it is a clone of another history`,
        );
      }
      const origin = configValue(readingClone, 'remote.origin.url');
      if (origin === undefined) {
        hostGit(['remote', 'add', 'origin', hostPath], { cwd: readingClone });
        log(`Added origin ${hostPath} to the reading clone ${readingClone}`);
      } else if (resolve(readingClone, origin) !== hostPath) {
        hostGit(['remote', 'set-url', 'origin', hostPath], {
          cwd: readingClone,
        });
        log(
          `Pointed the reading clone ${readingClone}'s origin at ${hostPath}; it was ${origin}`,
        );
      }
    }
  }
}

/**
 * Seeds a host repository from its remote, for every project of the
 * workspace: what `nx run <project>:seed-repository --repository=<name>
 * --remote=<https URL>` runs, from any agentic or workflow project.
 */
export default async function seedRepositoryExecutor(
  options: SeedRepositoryExecutorOptions,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  seedRepository(options, context.root, serveTasks(context));
  return { success: true };
}
