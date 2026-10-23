// Maintained by @beruangai/agentforge: `nx sync` rewrites this file to what the
// installed version generates. To own it, name it in the project's
// project.json metadata.agentforge.detached.files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AgentRuntime,
  type AgentRuntimeProps,
  type AgentSecrets,
} from '@beruangai/agentforge/infra';
import { REQUIRED_SECRETS as FRAMEWORK_SECRETS } from '@beruangai/agentforge/strands/infra';
import type { REQUIRED_SECRETS as PROJECT_SECRETS } from '@beruangai/strands-smoke/secrets';
import type { REQUIRED_SECRETS as AGENT_SECRETS } from '@beruangai/strands-smoke/hello-agent/secrets';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import type { Construct } from 'constructs';
import { RuntimeConfig } from '../../../../../core/runtime-config.js';
import { findWorkspaceRoot } from '../../../../../core/workspace.js';

const WORKSPACE_ROOT = findWorkspaceRoot(fileURLToPath(import.meta.url));
/** The agent's layer: its image's build context. */
const LAYER_DIRECTORY = join(
  WORKSPACE_ROOT,
  'packages/examples/strands-smoke/agents/hello-agent',
);
/** The id of the agentic image the agent's image builds on. */
const PARENT_IMAGE_ID_FILE = join(
  WORKSPACE_ROOT,
  'dist/packages/examples/strands-smoke/image/base.id',
);

function parentImageId(): string {
  try {
    return readFileSync(PARENT_IMAGE_ID_FILE, 'utf8').trim();
  } catch (error) {
    throw new Error(
      `${PARENT_IMAGE_ID_FILE} is missing: build the agentic image first, with nx run @beruangai/strands-smoke:image`,
      { cause: error },
    );
  }
}

/**
 * The hello-agent agent's secrets, by the environment variable each becomes:
 * its framework's, the base layer's and the agent's `REQUIRED_SECRETS`.
 */
export type Secrets = AgentSecrets<
  | (typeof FRAMEWORK_SECRETS)[number]
  | (typeof PROJECT_SECRETS)[number]
  | (typeof AGENT_SECRETS)[number]
>;

export type AgentProps = Omit<
  AgentRuntimeProps,
  'agentRuntimeArtifact' | 'secrets' | 'requiredSecrets' | 'agentName'
> & {
  readonly secrets: Secrets;
};

/**
 * strands-smoke's hello-agent agent as its own AgentCore runtime, registered in the
 * runtime configuration as StrandsSmokeHelloAgent.
 */
export class Agent extends AgentRuntime {
  constructor(scope: Construct, id: string, props: AgentProps) {
    super(scope, id, {
      ...props,
      agentName: 'hello-agent',
      requiredSecrets: FRAMEWORK_SECRETS,
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(LAYER_DIRECTORY, {
        platform: Platform.LINUX_ARM64,
        buildArgs: { BASE_IMAGE: 'beruangai/strands-smoke:local' },
        // The asset hash covers the agent's layer only; a change below it
        // changes the agentic image's id, and redeploys the agent.
        extraHash: parentImageId(),
      }),
    });
    const runtimeConfig = RuntimeConfig.ensure(this);
    runtimeConfig.set('agentcore', 'agentRuntimes', {
      ...runtimeConfig.get('agentcore').agentRuntimes,
      StrandsSmokeHelloAgent: { arn: this.agentRuntimeArn },
    });
  }
}
