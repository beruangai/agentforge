import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Get or create the session mount path for a container.
 * Sessions are keyed by container name (which is derived from config hash),
 * so the same config always gets the same session directory.
 */
export function sessionMountPath(sessionsDir: string, name: string): string {
  const sessionDir = join(sessionsDir, name, '.claude');
  mkdirSync(sessionDir, { recursive: true });
  return sessionDir;
}
