// The CDK app the AgentCore runtime test deploys: AgentForge's server, from
// the staged fixture image, through the `AgentRuntime` construct exactly as a
// consumer deploys an agent. Run by `cdk` with its inputs in the environment.
import { App, CfnOutput, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Platform } from 'aws-cdk-lib/aws-ecr-assets';
import { AgentRuntime } from '../../../../src/infra/index.ts';
import { INTEG_TAG } from '../../__fixtures__/aws-account.ts';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '')
    throw new Error(`${name} is not set`);
  return value;
}

const app = new App();
const stack = new Stack(app, required('AGENTFORGE_INTEG_STACK_NAME'), {
  env: {
    account: required('CDK_DEFAULT_ACCOUNT'),
    region: required('CDK_DEFAULT_REGION'),
  },
  tags: { [INTEG_TAG.Key]: INTEG_TAG.Value },
});
const agent = new AgentRuntime(stack, 'Agent', {
  // Named so the test role may read and delete the logs AgentCore creates.
  runtimeName: required('AGENTFORGE_INTEG_RUNTIME_NAME'),
  agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(
    required('AGENTFORGE_INTEG_IMAGE_CONTEXT'),
    {
      platform: Platform.LINUX_ARM64,
      buildArgs: { BASE_IMAGE: required('AGENTFORGE_INTEG_BASE_IMAGE') },
    },
  ),
  taskTableRemovalPolicy: RemovalPolicy.DESTROY,
});
new CfnOutput(stack, 'AgentRuntimeArn', { value: agent.agentRuntimeArn });
