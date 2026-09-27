import { join } from 'node:path';
import { runCommand } from '../../__fixtures__/run-command.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..', '..');
const WORKSPACE_ROOT = join(PACKAGE_ROOT, '..', '..');
/** The base image's build context; the `integ` target depends on `bundle`. */
const BUNDLE_DIRECTORY = join(
  WORKSPACE_ROOT,
  'dist/packages/agentforge/bundle',
);
/** The base image's `container` context: the workspace root's manifest and lock. */
const CONTAINER_DIRECTORY = join(PACKAGE_ROOT, 'container', 'workspace');

/** AgentForge's base image as the integ tests build it, local to this machine. */
export const AGENTFORGE_BASE_IMAGE = 'agentforge/a2a-claude:integ';

/**
 * Builds AgentForge's base image from the package's own `Dockerfile` over
 * the `bundle` task's output and the `container-lock` task's — what a
 * consumer's image is built `FROM`.
 */
export async function buildAgentForgeBaseImage(): Promise<void> {
  await runCommand(
    'docker',
    [
      'buildx',
      'build',
      '--platform',
      'linux/arm64',
      '--file',
      join(PACKAGE_ROOT, 'Dockerfile'),
      '--build-context',
      `container=${CONTAINER_DIRECTORY}`,
      '--tag',
      AGENTFORGE_BASE_IMAGE,
      '--load',
      BUNDLE_DIRECTORY,
    ],
    { purpose: `Building ${AGENTFORGE_BASE_IMAGE}` },
  );
}
