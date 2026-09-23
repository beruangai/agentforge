import { join } from 'node:path';

/**
 * Where a test task writes what it produces — recorded SDK messages, verified
 * downloads, per-run scratch — named for the task that runs it, under the
 * workspace's one output root: `dist/packages/agentforge/integ/`,
 * `dist/packages/agentforge/e2e/`. The source directory stays clean, and one
 * `dist/` holds everything to inspect or clean.
 */
export type TestTier = 'integ' | 'e2e';

export function taskOutputDirectory(task: TestTier): string {
  return join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'dist',
    'packages',
    'agentforge',
    task,
  );
}
