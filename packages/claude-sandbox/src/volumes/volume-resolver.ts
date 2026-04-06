import type { VolumeMap } from '../runner/types.js';

/**
 * Resolve a VolumeMap into Docker bind mount strings.
 * Supports both simple string targets and { target, readonly } objects.
 */
export function resolveVolumes(volumes?: VolumeMap): string[] {
  if (!volumes) return [];

  const binds: string[] = [];

  for (const [hostPath, value] of Object.entries(volumes)) {
    if (typeof value === 'string') {
      binds.push(`${hostPath}:${value}`);
    } else {
      const bind = `${hostPath}:${value.target}${value.readonly ? ':ro' : ''}`;
      binds.push(bind);
    }
  }

  return binds;
}
