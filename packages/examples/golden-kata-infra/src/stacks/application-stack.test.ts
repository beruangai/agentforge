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
  it("grants the worker's task role exactly the two agents and the runtime configuration read", () => {
    const stack = template();
    const taskDefinitions = Object.values(
      stack.findResources('AWS::ECS::TaskDefinition'),
    );
    expect(taskDefinitions).toHaveLength(1);
    const taskRole: unknown =
      taskDefinitions[0]?.Properties.TaskRoleArn['Fn::GetAtt']?.[0];
    expect(taskRole).toEqual(expect.any(String));
    const policies = Object.values(
      stack.findResources('AWS::IAM::Policy', {
        Properties: { Roles: [{ Ref: taskRole }] },
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

  it("polls the operator's Temporal Cloud namespace with the API key the operator stores", () => {
    const stack = template();
    const [container, ...others] = Object.values(
      stack.findResources('AWS::ECS::TaskDefinition'),
    ).flatMap((definition) => definition.Properties.ContainerDefinitions);
    expect(others).toEqual([]);
    expect(container.Environment).toEqual(
      expect.arrayContaining([
        {
          Name: 'TEMPORAL_ADDRESS',
          Value: 'beruangai-agentforge.vwhld.tmprl.cloud:7233',
        },
        { Name: 'TEMPORAL_NAMESPACE', Value: 'beruangai-agentforge.vwhld' },
      ]),
    );
    expect(JSON.stringify(container.Secrets)).toContain(
      'secret:agentforge/temporal-api-key',
    );
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
