// hello-agent's deployment: one AgentCore runtime serving this directory's
// image, through AgentForge's construct. `nx run @beruangai/example-hello-agent:deploy`
// runs it with the test role in us-east-2, after the base image it builds FROM.

import { AgentRuntime } from '@beruangai/agentforge/infra';
import { App, CfnOutput, Stack } from 'aws-cdk-lib';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new Error(`${name} is not set`);
  return value;
}

const app = new App();
const stack = new Stack(app, 'agentforge-example-hello-agent', {
  env: {
    account: required('CDK_DEFAULT_ACCOUNT'),
    region: required('CDK_DEFAULT_REGION'),
  },
});
const agent = new AgentRuntime(stack, 'HelloAgent', {
  agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(
    new URL('..', import.meta.url).pathname,
    {
      platform: Platform.LINUX_ARM64,
      // The asset hash covers this directory only; the base image it builds
      // FROM changes without it, and a deploy would not rebuild.
      extraHash: required('AGENTFORGE_BASE_IMAGE_ID'),
    },
  ),
  // The operator creates this secret and sets its value (README).
  secrets: {
    CLAUDE_CODE_OAUTH_TOKEN: Secret.fromSecretNameV2(
      stack,
      'SubscriptionToken',
      'agentforge/claude-code-oauth-token',
    ),
  },
});
new CfnOutput(stack, 'AgentRuntimeArn', { value: agent.agentRuntimeArn });
new CfnOutput(stack, 'SessionBucketName', {
  value: agent.sessionBucket.bucketName,
});
