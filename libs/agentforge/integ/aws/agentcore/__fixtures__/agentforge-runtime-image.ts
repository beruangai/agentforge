import { cp } from 'node:fs/promises';
import { join } from 'node:path';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
/**
 * The build context of an image over AgentForge's base image — built by the
 * package's `image` target, which `integ` depends on — running AgentForge's
 * server from source with the runtime fixture's procedures — no model. The
 * construct's CDK asset builds that image and publishes it, as a consumer's
 * agent image is.
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
}
