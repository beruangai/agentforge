import { App, Stack } from 'aws-cdk-lib';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../../infra/agent-runtime.ts';
import { AgenticProjectResources } from '../../../infra/agentic-project-resources.ts';
import { REQUIRED_SECRETS } from './index.ts';

function synthesize(withKey: boolean): void {
  const stack = new Stack(new App(), 'Agent', {
    env: { account: '123456789012', region: 'us-east-2' },
  });
  new AgentRuntime(stack, 'Agent', {
    project: new AgenticProjectResources(stack, 'Project', {
      projectName: 'strands-smoke',
    }),
    agentName: 'briefer',
    agentRuntimeArtifact: AgentRuntimeArtifact.fromImageUri(
      '123456789012.dkr.ecr.us-east-2.amazonaws.com/agent:latest',
    ),
    requiredSecrets: REQUIRED_SECRETS,
    secrets: withKey
      ? {
          ANTHROPIC_API_KEY: Secret.fromSecretNameV2(
            stack,
            'Key',
            'agentforge/anthropic-api-key',
          ),
        }
      : {},
  });
}

describe("strands' required secrets", () => {
  it('synthesize an agent declaring the API key', () => {
    expect(() => synthesize(true)).not.toThrow();
  });

  it('refuse an agent without it, naming it', () => {
    expect(() => synthesize(false)).toThrow(
      'ANTHROPIC_API_KEY is required: declare it in secrets',
    );
  });
});
