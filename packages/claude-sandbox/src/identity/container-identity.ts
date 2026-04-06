import { createHash } from 'node:crypto';

import type { VolumeMap } from '../runner/types.js';

/**
 * Stable identity hash for a task configuration.
 * Used to key session directories — same config always gets the same session mount.
 * NOT used for container naming (containers get unique names per execution).
 */
export function taskIdentityHash(
  taskName: string,
  image: string,
  volumes?: VolumeMap,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        taskName,
        image,
        volumes: sortedEntries(volumes),
      }),
    )
    .digest('hex')
    .slice(0, 12);
}

/**
 * Generate a unique container name for a single execution.
 * Includes the task name for debuggability, plus a unique suffix
 * to prevent Docker name collisions on concurrent runs.
 */
export function containerName(taskName: string, executionId: string): string {
  // Sanitize task name for Docker container naming (lowercase alphanumeric + hyphens)
  const safeName = taskName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  return `agentforge-${safeName}-${executionId}`;
}

function sortedEntries(volumes?: VolumeMap): [string, unknown][] {
  if (!volumes) return [];
  return Object.entries(volumes).sort(([a], [b]) => a.localeCompare(b));
}
