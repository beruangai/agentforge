import { spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';

/**
 * Runs the host's own `git`, with its own environment and configuration —
 * its credential helper among them — and returns its trimmed stdout. A
 * failure names the command and git's stderr, which carries no secret: no
 * URL AgentForge passes carries one.
 */
export function hostGit(
  args: readonly string[],
  options: { readonly cwd?: string; readonly inheritOutput?: boolean } = {},
): string {
  const result = spawnSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: options.inheritOutput === true ? 'inherit' : 'pipe',
  });
  if (result.error !== undefined) {
    throw new Error(
      `git could not run: ${result.error.message}; install git 2.40 or later`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited ${result.status ?? result.signal}${
        result.stderr ? `: ${result.stderr.trim()}` : ''
      }`,
    );
  }
  return (result.stdout ?? '').trim();
}

/** Like `hostGit`, but answers undefined where git exits non-zero. */
function tryHostGit(args: readonly string[], cwd: string): string | undefined {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error !== undefined) {
    throw new Error(
      `git could not run: ${result.error.message}; install git 2.40 or later`,
    );
  }
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * What a host path holds: a bare repository at its own root, a working
 * clone at its own root, nothing, or something else — a plain directory,
 * a file, or a directory inside a repository around it, which `git -C`
 * would otherwise report as that repository.
 */
export type HostPathKind = 'absent' | 'bare' | 'working' | 'other';

export function hostPathKind(path: string): HostPathKind {
  if (!existsSync(path)) return 'absent';
  if (!statSync(path).isDirectory()) return 'other';
  const gitDirectory = tryHostGit(['rev-parse', '--absolute-git-dir'], path);
  if (gitDirectory === undefined) return 'other';
  const own = realpathSync(path);
  if (realpathSync(gitDirectory) === own) {
    return tryHostGit(['rev-parse', '--is-bare-repository'], path) === 'true'
      ? 'bare'
      : 'other';
  }
  const topLevel = tryHostGit(['rev-parse', '--show-toplevel'], path);
  return topLevel !== undefined && realpathSync(topLevel) === own
    ? 'working'
    : 'other';
}

/** A configuration value of a repository, or undefined when unset. */
export function configValue(path: string, key: string): string | undefined {
  return tryHostGit(['config', '--get', key], path);
}

/** Lets a local clone of the repository be blobless, as a git filesystem clones it. */
export function allowPartialClones(path: string): void {
  if (configValue(path, 'uploadpack.allowFilter') !== 'true') {
    hostGit(['config', 'uploadpack.allowFilter', 'true'], { cwd: path });
  }
}
