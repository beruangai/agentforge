import { join } from 'node:path';

/**
 * Where the `integ` task writes what it produces — recorded SDK messages,
 * verified downloads, per-run scratch — under the workspace's one output root,
 * named for the task: `dist/libs/agentforge/integ/`. The source directory
 * stays clean, and one `dist/` holds everything to inspect or clean.
 */
export function taskOutputDirectory(): string {
  return join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'dist',
    'packages',
    'agentforge',
    'integ',
  );
}
