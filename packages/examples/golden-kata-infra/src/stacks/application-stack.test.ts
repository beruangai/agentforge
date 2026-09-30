import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApplicationStack } from './application-stack.js';

function template(): Template {
  return Template.fromStack(
    new ApplicationStack(new App(), 'Test', {
      env: { account: '123456789012', region: 'us-east-2' },
    }),
  );
}

describe('golden-kata-infra', () => {
  it('lets the caller invoke exactly the two agents and read the runtime configuration', () => {
    const stack = template();
    const [caller, ...otherCallers] = Object.keys(
      stack.findResources('AWS::IAM::Role'),
    ).filter((logicalId) => logicalId.startsWith('Caller'));
    expect(caller).toBeDefined();
    expect(otherCallers).toEqual([]);
    const policies = Object.values(
      stack.findResources('AWS::IAM::Policy', {
        Properties: { Roles: [{ Ref: caller }] },
      }),
    );
    expect(policies).toHaveLength(1);

    const runtimes = Object.keys(
      stack.findResources('AWS::BedrockAgentCore::Runtime'),
    );
    expect(runtimes).toHaveLength(2);
    const invoke = (runtime: string) => {
      const arn = { 'Fn::GetAtt': [runtime, 'AgentRuntimeArn'] };
      return {
        Action: 'bedrock-agentcore:InvokeAgentRuntime',
        Effect: 'Allow',
        Resource: [arn, { 'Fn::Join': ['', [arn, '/*']] }],
      };
    };
    expect(policies[0]?.Properties.PolicyDocument.Statement).toEqual([
      ...runtimes.map(invoke),
      {
        Action: [
          'appconfig:StartConfigurationSession',
          'appconfig:GetLatestConfiguration',
        ],
        Effect: 'Allow',
        Resource: {
          'Fn::Join': [
            '',
            [
              'arn:',
              { Ref: 'AWS::Partition' },
              ':appconfig:us-east-2:123456789012:application/',
              { Ref: 'RcAppConfigApp' },
              '/*',
            ],
          ],
        },
      },
    ]);
  });

  it('registers both agents in the runtime configuration and names its application', () => {
    const stack = template();
    stack.hasResourceProperties('AWS::AppConfig::ConfigurationProfile', {
      Name: 'agentcore',
    });
    const content = JSON.stringify(
      Object.values(
        stack.findResources('AWS::AppConfig::HostedConfigurationVersion'),
      ).map((version) => version.Properties.Content),
    );
    expect(content).toContain('GoldenKataWriter');
    expect(content).toContain('GoldenKataGrader');
    stack.hasOutput('RuntimeConfigApplicationId', {});
  });
});
