import { type Dirent, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Pattern matching .env files: `.env` or `.env.*` (e.g., `.env.local`, `.env.production`)
 */
const ENV_FILE_PATTERN = /^\.env(\..+)?$/;

/**
 * Parse a Docker bind mount string into host path and container path.
 * Format: `/host/path:/container/path[:ro]`
 */
function parseBind(
  bind: string,
): { hostPath: string; containerPath: string } | null {
  const parts = bind.split(':');
  if (parts.length < 2) return null;
  return { hostPath: parts[0], containerPath: parts[1] };
}

/**
 * Recursively find all .env files under a directory.
 * Does not follow symlinks. Silently skips directories that can't be read.
 */
function findEnvFiles(dir: string): string[] {
  const results: string[] = [];

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch (error) {
    console.warn(
      `[agentforge] env-shadow: failed to read directory "${dir}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return results;
  }

  for (const entry of entries) {
    const name = entry.name as unknown as string;
    const fullPath = join(dir, name);

    if (entry.isSymbolicLink()) {
      continue;
    }

    if (entry.isDirectory()) {
      results.push(...findEnvFiles(fullPath));
    } else if (entry.isFile() && ENV_FILE_PATTERN.test(name)) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Generate /dev/null bind mounts to shadow .env files in mounted volumes.
 * Prevents container agents from reading host secrets through project mounts.
 */
export function generateEnvShadowMounts(binds: string[]): string[] {
  const shadowMounts: string[] = [];

  for (const bind of binds) {
    const parsed = parseBind(bind);
    if (!parsed) continue;

    const { hostPath, containerPath } = parsed;

    // Verify host path exists and is a directory
    let stat;
    try {
      stat = statSync(hostPath);
    } catch (error) {
      console.warn(
        `[agentforge] env-shadow: cannot stat host path "${hostPath}": ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (!stat.isDirectory()) continue;

    const envFiles = findEnvFiles(hostPath);

    for (const envFile of envFiles) {
      const rel = relative(hostPath, envFile);
      const containerEnvPath = join(containerPath, rel);
      shadowMounts.push(`/dev/null:${containerEnvPath}`);
    }
  }

  return shadowMounts;
}
