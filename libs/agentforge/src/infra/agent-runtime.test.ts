import { App, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import { AgentRuntime, type AgentRuntimeProps } from './agent-runtime.ts';
import { AgenticProjectResources } from './agentic-project-resources.ts';
import { S3FilesystemBucket } from './s3-filesystem-bucket.ts';

const IMAGE = AgentRuntimeArtifact.fromImageUri(
  '123456789012.dkr.ecr.us-east-2.amazonaws.com/agent:latest',
);

function synthesize(
  props:
    | Partial<AgentRuntimeProps>
    | ((stack: Stack) => Partial<AgentRuntimeProps>) = {},
): Template {
  const stack = new Stack(new App(), 'Agent', {
    env: { account: '123456789012', region: 'us-east-2' },
  });
  new AgentRuntime(stack, 'Agent', {
    project: new AgenticProjectResources(stack, 'Project', {
      projectName: 'smoke-coverage',
    }),
    agentName: 'hello-agent',
    agentRuntimeArtifact: IMAGE,
    secrets: {
      CLAUDE_CODE_OAUTH_TOKEN: Secret.fromSecretNameV2(
        stack,
        'Token',
        'agentforge/claude-code-oauth-token',
      ),
    },
    ...(typeof props === 'function' ? props(stack) : props),
  });
  return Template.fromStack(stack);
}

describe('AgentRuntime', () => {
  it("runs on V2 over A2A, with A2A-Version, the project's table and bucket and the agent's name added to what the consumer declares", () => {
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
        AGENTFORGE_AGENT_NAME: 'hello-agent',
        AGENTFORGE_TABLE_NAME: { Ref: Match.stringLikeRegexp('TaskTable') },
        AGENTFORGE_SESSION_BUCKET: {
          Ref: Match.stringLikeRegexp('SessionBucket'),
        },
        AGENTFORGE_TELEMETRY: 'INFO',
      },
    });
  });

  it("may read and write the project's task table, and its transcripts under its own name alone", () => {
    const template = synthesize();
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['dynamodb:PutItem']),
            Resource: Match.arrayWith([
              { 'Fn::GetAtt': [Match.stringLikeRegexp('TaskTable'), 'Arn'] },
            ]),
          }),
          {
            Action: ['s3:GetObject', 's3:PutObject'],
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  {
                    'Fn::GetAtt': [
                      Match.stringLikeRegexp('SessionBucket'),
                      'Arn',
                    ],
                  },
                  '/hello-agent/*',
                ],
              ],
            },
          },
          {
            Action: 's3:ListBucket',
            Condition: { StringLike: { 's3:prefix': 'hello-agent/*' } },
            Effect: 'Allow',
            Resource: {
              'Fn::GetAtt': [Match.stringLikeRegexp('SessionBucket'), 'Arn'],
            },
          },
        ]),
      },
    });
    // No grant reaches the bucket's objects beyond the agent's prefix.
    const statements = Object.values(
      template.findResources('AWS::IAM::Policy'),
    ).flatMap((policy) => policy.Properties.PolicyDocument.Statement);
    expect(
      statements.filter((statement) =>
        JSON.stringify(statement.Resource).includes('SessionBucket'),
      ),
    ).toHaveLength(2);
  });

  it('counts per agent under its runtime name, may publish only to its namespace, and charts it beside AgentCore', () => {
    const template = synthesize({ runtimeName: 'agent_runtime' });
    template.hasResourceProperties('AWS::BedrockAgentCore::Runtime', {
      EnvironmentVariables: Match.objectLike({
        AGENTFORGE_METRICS_RUNTIME_NAME: 'agent_runtime',
      }),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          {
            Action: 'cloudwatch:PutMetricData',
            Condition: {
              StringEquals: { 'cloudwatch:namespace': 'AgentForge' },
            },
            Effect: 'Allow',
            Resource: '*',
          },
        ]),
      },
    });
    const body = JSON.stringify(
      template.findResources('AWS::CloudWatch::Dashboard'),
    );
    expect(body).toContain('TasksLost');
    expect(body).toContain('agent_runtime::DEFAULT');
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

  it('delivers service spans to AgentCore Observability, with leave to write them to its log group', () => {
    const template = synthesize();
    template.hasResourceProperties('AWS::Logs::DeliverySource', {
      LogType: 'TRACES',
    });
    template.hasResourceProperties('AWS::Logs::DeliveryDestination', {
      DeliveryDestinationType: 'XRAY',
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'logs:PutResourcePolicy' }),
        ]),
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'cloudwatch:PutMetricData',
            Resource: {
              'Fn::Join': [
                '',
                Match.arrayWith([Match.stringLikeRegexp(':dataset/default$')]),
              ],
            },
          }),
        ]),
      },
    });
  });

  it('delivers no spans when the consumer turns tracing off', () => {
    synthesize({ tracingEnabled: false }).resourceCountIs(
      'AWS::Logs::DeliverySource',
      0,
    );
  });

  it('names its declared secrets to the server, and may read those alone', () => {
    const template = synthesize();
    // The ARN joins in the partition, so the JSON is an Fn::Join.
    const [runtime] = Object.values(
      template.findResources('AWS::BedrockAgentCore::Runtime'),
    );
    const declared = JSON.stringify(
      runtime?.Properties.EnvironmentVariables.AGENTFORGE_SECRETS,
    );
    expect(declared).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(declared).toContain('secret:agentforge/claude-code-oauth-token');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
              'secretsmanager:GetSecretValue',
              'secretsmanager:DescribeSecret',
            ],
          }),
        ]),
      },
    });
  });

  it('exports the telemetry level the consumer chooses', () => {
    synthesize({ telemetry: 'DEBUG' }).hasResourceProperties(
      'AWS::BedrockAgentCore::Runtime',
      {
        EnvironmentVariables: Match.objectLike({
          AGENTFORGE_TELEMETRY: 'DEBUG',
        }),
      },
    );
  });

  it('refuses a secret also set as a plain variable', () => {
    expect(() =>
      synthesize({
        environmentVariables: { CLAUDE_CODE_OAUTH_TOKEN: 'plain' },
      }),
    ).toThrow(/both as a secret/);
  });

  it('refuses secrets without the subscription token AgentForge requires', () => {
    expect(() => synthesize({ secrets: {} as never })).toThrow(
      'CLAUDE_CODE_OAUTH_TOKEN is required: declare it in secrets',
    );
  });

  it('refuses a table name or an agent name the consumer set, which the construct owns', () => {
    expect(() =>
      synthesize({ environmentVariables: { AGENTFORGE_TABLE_NAME: 'mine' } }),
    ).toThrow(/AGENTFORGE_TABLE_NAME/);
    expect(() =>
      synthesize({ environmentVariables: { AGENTFORGE_AGENT_NAME: 'other' } }),
    ).toThrow(/AGENTFORGE_AGENT_NAME is set by AgentRuntime/);
  });

  it('refuses an agent name that is not kebab-case', () => {
    expect(() => synthesize({ agentName: 'Hello_Agent' })).toThrow(
      /agent name "Hello_Agent" must match/,
    );
  });

  it('names its filesystem buckets to the harness, and may read and write each', () => {
    const template = synthesize((stack) => ({
      filesystems: { vault: new S3FilesystemBucket(stack, 'Vault') },
    }));
    const [runtime] = Object.values(
      template.findResources('AWS::BedrockAgentCore::Runtime'),
    );
    const declared = JSON.stringify(
      runtime?.Properties.EnvironmentVariables.AGENTFORGE_FILESYSTEM_BUCKETS,
    );
    expect(declared).toContain('\\"vault\\":');
    expect(declared).toContain('VaultBucket');
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:DeleteObject*', 's3:PutObject']),
            Resource: Match.arrayWith([
              { 'Fn::GetAtt': [Match.stringLikeRegexp('^VaultBucket'), 'Arn'] },
            ]),
          }),
        ]),
      },
    });
  });

  it('refuses a bucket name a filesystem could not declare', () => {
    expect(() =>
      synthesize((stack) => ({
        filesystems: { Vault: new S3FilesystemBucket(stack, 'Vault') },
      })),
    ).toThrow(/filesystem bucket name "Vault"/);
  });
});
