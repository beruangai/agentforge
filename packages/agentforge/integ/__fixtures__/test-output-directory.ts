import { join } from 'node:path';

/**
 * Where tests write what they produce — recorded SDK messages, verified
 * downloads, per-run scratch — under the workspace's one output root,
 * `dist/packages/agentforge/`, beside every other output, so the package's
 * source directory stays clean and one `dist/` holds everything to inspect or
 * clean.
 */
export const testOutputDirectory = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'dist',
  'packages',
  'agentforge',
  'test-output',
);
