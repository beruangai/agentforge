import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { runCommand } from '../../../__fixtures__/run-command.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const WORKSPACE_ROOT = join(PACKAGE_ROOT, '..', '..');
/** The base image's build context; the `integ` target depends on `bundle`. */
const BUNDLE_DIRECTORY = join(
  WORKSPACE_ROOT,
  'dist/packages/agentforge/bundle',
);
/** The base image's `container` context: the workspace root's manifest and lock. */
const CONTAINER_DIRECTORY = join(PACKAGE_ROOT, 'container', 'workspace');

/** The base image the fixture image is built `FROM`, local to this machine. */
export const AGENTFORGE_BASE_IMAGE = 'agentforge/a2a-claude:integ';

/**
 * AgentForge's base image, built locally from the package's own `Dockerfile`
 * over the `bundle` task's output and the `container-lock` task's, and the
 * build context of an image over it running AgentForge's server from source
 * with the runtime fixture's procedures — no model. The construct's CDK asset
 * builds that image and publishes it, as a consumer's agent image is.
 */
export async function stageAgentForgeRuntimeImage(
  contextDirectory: string,
): Promise<void> {
  const source = join(contextDirectory, 'source');
  for (const part of [
    'package.json',
    'src',
    'integ/local/runtime/__fixtures__',
    'integ/aws/agentcore/__fixtures__/agentforge-server.ts',
  ]) {
    await cp(join(PACKAGE_ROOT, part), join(source, part), {
      recursive: true,
    });
  }
  await cp(
    join(import.meta.dirname, 'agentforge-runtime.Dockerfile'),
    join(contextDirectory, 'Dockerfile'),
  );
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
