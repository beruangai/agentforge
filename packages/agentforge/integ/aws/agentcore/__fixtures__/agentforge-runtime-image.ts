import { cp, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../../__fixtures__/run-command.ts';
import type { AwsEnvironment } from './aws-environment.ts';
import {
  type PushedImage,
  writeDockerConfigWithEcrCredentialHelper,
} from './image.ts';

const packageRoot = join(import.meta.dirname, '..', '..', '..', '..');
const workspaceRoot = join(packageRoot, '..', '..');

/**
 * AgentForge's base image, from the package's own `Dockerfile`, and over it an
 * image running AgentForge's server with the runtime fixture's procedures —
 * no model, no bundle. Pushed to ECR through the credential helper, as the
 * fixture image is; the context is a temporary directory.
 */
export async function buildAndPushAgentForgeRuntimeImage(
  environment: AwsEnvironment,
  repositoryUri: string,
): Promise<PushedImage> {
  const scratchDirectory = await mkdtemp(
    join(tmpdir(), 'agentforge-integ-agentforge-runtime-image-'),
  );
  try {
    const context = join(scratchDirectory, 'context');
    const workspace = join(context, 'workspace');
    const source = join(context, 'source');
    for (const file of ['package.json', 'bun.lock']) {
      await cp(join(workspaceRoot, file), join(workspace, file));
    }
    // A frozen install checks every workspace's manifest against the lockfile.
    for (const parent of ['packages', 'examples']) {
      for (const project of await readdir(join(workspaceRoot, parent))) {
        await cp(
          join(workspaceRoot, parent, project, 'package.json'),
          join(workspace, parent, project, 'package.json'),
        );
      }
    }
    for (const part of [
      'src',
      'integ/local/runtime/__fixtures__',
      'integ/aws/agentcore/__fixtures__/agentforge-server.ts',
    ]) {
      await cp(join(packageRoot, part), join(source, part), {
        recursive: true,
      });
    }
    await cp(join(packageRoot, 'Dockerfile'), join(context, 'base.Dockerfile'));
    await cp(
      join(import.meta.dirname, 'agentforge-runtime.Dockerfile'),
      join(context, 'Dockerfile'),
    );

    const dockerConfigDirectory = join(scratchDirectory, 'docker-config');
    await mkdir(dockerConfigDirectory);
    await writeDockerConfigWithEcrCredentialHelper(
      dockerConfigDirectory,
      environment.registry,
    );
    const dockerEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      DOCKER_CONFIG: dockerConfigDirectory,
      AWS_ECR_DISABLE_CACHE: 'true',
    };
    const baseImage = 'agentforge/a2a-claude:integ';
    await runCommand(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        'linux/arm64',
        '--file',
        join(context, 'base.Dockerfile'),
        '--tag',
        baseImage,
        '--load',
        context,
      ],
      { purpose: `Building ${baseImage}`, environment: dockerEnvironment },
    );
    const imageUri = `${repositoryUri}:agentforge-runtime`;
    const metadataFile = join(scratchDirectory, 'metadata.json');
    await runCommand(
      'docker',
      [
        'buildx',
        'build',
        '--platform',
        'linux/arm64',
        '--build-arg',
        `BASE_IMAGE=${baseImage}`,
        '--tag',
        imageUri,
        '--metadata-file',
        metadataFile,
        '--provenance=false',
        '--push',
        context,
      ],
      {
        purpose: `Building and pushing ${imageUri}`,
        environment: dockerEnvironment,
      },
    );
    const metadata = JSON.parse(await readFile(metadataFile, 'utf8')) as Record<
      string,
      unknown
    >;
    const digest = metadata['containerimage.digest'];
    if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `buildx metadata for ${imageUri} has no manifest digest: ${JSON.stringify(metadata)}`,
      );
    }
    return { imageUri, digest };
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}
