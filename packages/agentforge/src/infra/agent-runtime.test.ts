import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { describe, expect, it } from 'vitest';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';
import { AgentRuntime, type AgentRuntimeProps } from './agent-runtime.ts';

const IMAGE = AgentRuntimeArtifact.fromImageUri(
  '123456789012.dkr.ecr.us-east-2.amazonaws.com/agent:latest',
);

function synthesize(props: Partial<AgentRuntimeProps> = {}): Template {
  const stack = new Stack(new App(), 'Agent', {
    env: { account: '123456789012', region: 'us-east-2' },
  });
  new AgentRuntime(stack, 'Agent', { agentRuntimeArtifact: IMAGE, ...props });
  return Template.fromStack(stack);
}

describe('AgentRuntime', () => {
  it('runs on V2 over A2A, with A2A-Version and the task table added to what the consumer declares', () => {
    const template = synthesize({
      environmentVariables: { AGENTFORGE_ADMISSION_LIMIT: '2' },
      requestHeaderConfiguration: { allowlistedHeaders: ['X-Trace'] },
    });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      PlatformVersion: 'V2',
      ProtocolConfiguration: 'A2A',
      RequestHeaderConfiguration: {
        RequestHeaderAllowlist: ['X-Trace', 'A2A-Version'],
      },
      EnvironmentVariables: {
        AGENTFORGE_ADMISSION_LIMIT: '2',
        AGENTFORGE_TABLE_NAME: { Ref: Match.stringLikeRegexp('TaskTable') },
      },
    });
  });

  it("deploys the task table with the task store's own key and expiry", () => {
    synthesize().hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: TASK_TABLE_PARTITION_KEY, KeyType: 'HASH' }],
      TimeToLiveSpecification: {
        AttributeName: TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
        Enabled: true,
      },
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  it('probes the runtime at every new version, with leave to invoke it', () => {
    const template = synthesize();
    template.hasResourceProperties('Custom::AgentForgeReadiness', {
      AgentRuntimeArn: Match.anyValue(),
      AgentRuntimeVersion: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'bedrock-agentcore:InvokeAgentRuntime' }),
        ]),
      },
    });
    // The probe is the only function: no provider outlives the stack.
    template.resourceCountIs('AWS::Lambda::Function', 1);
  });

  it('refuses a table name the consumer set, which the construct owns', () => {
    expect(() =>
      synthesize({ environmentVariables: { AGENTFORGE_TABLE_NAME: 'mine' } }),
    ).toThrow(/AGENTFORGE_TABLE_NAME/);
  });
});
