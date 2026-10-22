import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExecutorContext } from '@nx/devkit';
import {
  agentforgeContainerInputs,
  type ContainerInputs,
} from '../../container/container-inputs.ts';
import {
  agentforgeImage,
  agentImage,
  agenticImage,
  agentOfLayer,
  frameworkImage,
  frameworkOfLayer,
  imageIdFile,
  type Layer,
} from '../../container/images.ts';
import type { AgenticProject } from '../../project-record.ts';
import { executorProject } from '../executor-project.ts';

export interface ImageExecutorOptions {
  /** `agentforge`, `agentforge-<framework>`, `base`, or `agents/<agent>`. */
  readonly layer: string;
  /**
   * Further named build contexts for a project's layer, by name, each a
   * workspace-relative directory its Dockerfile copies from with
   * `COPY --from=<name>`: a host project's build output, say.
   */
  readonly buildContexts?: Readonly<Record<string, string>>;
}

export interface ImageBuild {
  /** `docker` and its arguments. */
  readonly args: readonly string[];
  readonly tag: string;
  /** Where the image's id is written, absolute. */
  readonly idFile: string;
}

/** The ARM64 build of one layer, `FROM` its parent through `BASE_IMAGE`, writing its id: the base image alone is `FROM` none. */
export function imageBuild(
  project: AgenticProject,
  layer: string,
  inputs: Pick<
    ContainerInputs,
    | 'packageDirectory'
    | 'dockerfile'
    | 'containerDirectory'
    | 'version'
    | 'frameworks'
  >,
  workspaceRoot: string,
  buildContexts: Readonly<Record<string, string>> = {},
): ImageBuild {
  const agentName = agentOfLayer(project, layer);
  const framework = frameworkOfLayer(layer);
  if (
    (layer === 'agentforge' || framework !== undefined) &&
    Object.keys(buildContexts).length > 0
  ) {
    throw new Error(
      "AgentForge's images are AgentForge's; build contexts extend a project's layer",
    );
  }
  if (framework !== undefined && framework !== project.framework) {
    throw new Error(
      `${project.name} runs on the ${project.framework} framework; it builds no ${layer} image`,
    );
  }
  const contexts = Object.entries(buildContexts).flatMap(([name, path]) => [
    '--build-context',
    `${name}=${join(workspaceRoot, path)}`,
  ]);
  const idFile = join(workspaceRoot, imageIdFile(project.root, layer as Layer));
  const build = (tag: string, context: string, options: string[]) => ({
    args: [
      'build',
      '--platform',
      'linux/arm64',
      ...options,
      '--tag',
      tag,
      '--iidfile',
      idFile,
      context,
    ],
    tag,
    idFile,
  });
  if (layer === 'agentforge') {
    return build(agentforgeImage(inputs.version), inputs.packageDirectory, [
      '--file',
      inputs.dockerfile,
      '--build-context',
      `container=${inputs.containerDirectory}`,
    ]);
  }
  if (framework !== undefined) {
    const frameworkInputs = inputs.frameworks[framework];
    return build(
      frameworkImage(framework, inputs.version),
      frameworkInputs.containerDirectory,
      [
        '--file',
        frameworkInputs.dockerfile,
        '--build-arg',
        `BASE_IMAGE=${agentforgeImage(inputs.version)}`,
        '--build-context',
        `container=${frameworkInputs.containerDirectory}`,
      ],
    );
  }
  if (agentName === undefined) {
    return build(
      agenticImage(project),
      join(workspaceRoot, project.root, 'base'),
      [
        '--build-arg',
        `BASE_IMAGE=${frameworkImage(project.framework, inputs.version)}`,
        ...contexts,
      ],
    );
  }
  return build(
    agentImage(project, agentName),
    join(workspaceRoot, project.root, 'agents', agentName),
    ['--build-arg', `BASE_IMAGE=${agenticImage(project)}`, ...contexts],
  );
}

export default async function imageExecutor(
  options: ImageExecutorOptions,
  context: ExecutorContext,
): Promise<{ success: boolean }> {
  const build = imageBuild(
    executorProject(context),
    options.layer,
    agentforgeContainerInputs(),
    context.root,
    options.buildContexts,
  );
  mkdirSync(dirname(build.idFile), { recursive: true });
  const result = spawnSync('docker', build.args, { stdio: 'inherit' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `docker build of ${build.tag} exited ${result.status ?? result.signal}`,
    );
  }
  return { success: true };
}
