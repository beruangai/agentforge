import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommand } from '../../../__fixtures__/run-command.ts';
import { AGENTFORGE_BASE_IMAGE } from '../../__fixtures__/agentforge-base-image.ts';
import { stageAgentForgeRuntimeImage } from './agentforge-runtime-image.ts';
import type { ResourceNames } from './aws-environment.ts';
import {
  type AgentCoreClients,
  deleteRuntimeLogGroups,
} from './provisioning.ts';

const PACKAGE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const CDK = join(PACKAGE_ROOT, 'node_modules', '.bin', 'cdk');
const APP = `bun ${join(import.meta.dirname, 'agentforge-runtime-app.ts')}`;

/**
 * A deploy builds and publishes the image and waits for the construct's
 * readiness probe, after a V2 create that takes minutes; a destroy waits out
 * the runtime's deletion. The publish dominates when the base image's
 * dependency layer changed: its ~500 MB took 25 minutes to upload on
 * 2026-09-25.
 */
export const DEPLOYMENT_TIMEOUT_MILLISECONDS = 3_600_000;

/**
 * Deploys AgentForge's server through the `AgentRuntime` construct with the
 * CDK CLI, as the test role through the bootstrap roles
 * (integ/aws/agentcore/README.md), and defers its destroy and the log groups
 * AgentCore leaves outside the stack. Returns once the deploy does — which,
 * through the probe, is once the runtime serves.
 */
export async function deployAgentForgeRuntime(
  resources: AsyncDisposableStack,
  clients: AgentCoreClients,
  names: ResourceNames,
): Promise<{ agentRuntimeArn: string }> {
  const scratchDirectory = await mkdtemp(
    join(tmpdir(), 'agentforge-integ-deployment-'),
  );
  resources.defer(() => rm(scratchDirectory, { recursive: true, force: true }));
  const contextDirectory = join(scratchDirectory, 'context');
  await stageAgentForgeRuntimeImage(contextDirectory);
  // The asset publish always runs `docker login`, which the ECR credential
  // helper refuses to store ("not implemented") and Docker Desktop's own
  // helper holds on a keychain prompt no one sees. With an empty
  // configuration Docker falls back to `docker-credential-osxkeychain`, so the
  // 12-hour ECR login lands in the keychain, as it does for any CDK user.
  const dockerConfigDirectory = join(scratchDirectory, 'docker-config');
  await mkdir(dockerConfigDirectory);
  await writeFile(join(dockerConfigDirectory, 'config.json'), '{}\n');
  const cdkEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    DOCKER_CONFIG: dockerConfigDirectory,
    CDK_DISABLE_CLI_TELEMETRY: 'true',
    AGENTFORGE_INTEG_STACK_NAME: names.stackName,
    AGENTFORGE_INTEG_RUNTIME_NAME: names.agentRuntimeName,
    AGENTFORGE_INTEG_IMAGE_CONTEXT: contextDirectory,
    AGENTFORGE_INTEG_BASE_IMAGE: AGENTFORGE_BASE_IMAGE,
  };
  const cdk = (command: string, extra: readonly string[], purpose: string) =>
    runCommand(
      CDK,
      [
        command,
        names.stackName,
        '--app',
        APP,
        '--output',
        join(scratchDirectory, 'cdk.out'),
        '--no-notices',
        ...extra,
      ],
      { purpose, environment: cdkEnvironment },
    );

  // Released last-in first-out: the stack, then the logs outside it.
  resources.defer(() =>
    deleteRuntimeLogGroups(clients, { agentRuntimeId: names.agentRuntimeName }),
  );
  resources.defer(async () => {
    await cdk('destroy', ['--force'], `Destroying ${names.stackName}`);
  });
  const outputsFile = join(scratchDirectory, 'outputs.json');
  await cdk(
    'deploy',
    ['--require-approval', 'never', '--outputs-file', outputsFile],
    `Deploying ${names.stackName}`,
  );
  const outputs = JSON.parse(await readFile(outputsFile, 'utf8')) as Record<
    string,
    Record<string, string> | undefined
  >;
  const agentRuntimeArn = outputs[names.stackName]?.AgentRuntimeArn;
  if (agentRuntimeArn === undefined) {
    throw new Error(
      `${names.stackName} has no AgentRuntimeArn output: ${JSON.stringify(outputs)}`,
    );
  }
  return { agentRuntimeArn };
}
