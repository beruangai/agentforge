import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';
import { AgentRuntime, type AgentRuntimeProps } from './agent-runtime.ts';
import { WorkingDirectory } from './working-directory.ts';

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
    agentRuntimeArtifact: IMAGE,
    ...(typeof props === 'function' ? props(stack) : props),
  });
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
        AGENTFORGE_SESSION_BUCKET: {
          Ref: Match.stringLikeRegexp('SessionBucket'),
        },
        AGENTFORGE_TELEMETRY: 'INFO',
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
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    });
  });

  it('persists session transcripts in a private, encrypted, versioned bucket it may read and write, expired after 30 days', () => {
    const template = synthesize();
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          { ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: {
        Rules: [
          {
            ExpirationInDays: 30,
            NoncurrentVersionExpiration: { NoncurrentDays: 1 },
            Status: 'Enabled',
          },
          { ExpiredObjectDeleteMarker: true, Status: 'Enabled' },
        ],
      },
    });
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Metadata: {
        checkov: {
          skip: [
            { id: 'CKV_AWS_18', comment: Match.stringLikeRegexp('audit') },
          ],
        },
      },
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['s3:PutObject']),
            Resource: Match.arrayWith([
              {
                'Fn::GetAtt': [Match.stringLikeRegexp('SessionBucket'), 'Arn'],
              },
            ]),
          }),
        ]),
      },
    });
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

  it('keeps transcripts as long as the consumer chooses', () => {
    synthesize({ sessionRetention: Duration.days(365) }).hasResourceProperties(
      'AWS::S3::Bucket',
      {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 365 })]),
        },
      },
    );
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
    const template = synthesize((stack) => ({
      secrets: {
        CLAUDE_CODE_OAUTH_TOKEN: Secret.fromSecretNameV2(
          stack,
          'Token',
          'agentforge/claude-code-oauth-token',
        ),
      },
    }));
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
      synthesize((stack) => ({
        environmentVariables: { CLAUDE_CODE_OAUTH_TOKEN: 'plain' },
        secrets: {
          CLAUDE_CODE_OAUTH_TOKEN: Secret.fromSecretNameV2(
            stack,
            'Token',
            'token',
          ),
        },
      })),
    ).toThrow(/both as a secret/);
  });

  it('refuses a table name the consumer set, which the construct owns', () => {
    expect(() =>
      synthesize({ environmentVariables: { AGENTFORGE_TABLE_NAME: 'mine' } }),
    ).toThrow(/AGENTFORGE_TABLE_NAME/);
  });

  it('names its working directories to the harness, and may read and write each', () => {
    const template = synthesize((stack) => ({
      workingDirectories: { vault: new WorkingDirectory(stack, 'Vault') },
    }));
    const [runtime] = Object.values(
      template.findResources('AWS::BedrockAgentCore::Runtime'),
    );
    const declared = JSON.stringify(
      runtime?.Properties.EnvironmentVariables.AGENTFORGE_WORKING_DIRECTORIES,
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

  it('refuses a working directory name a procedure could not open', () => {
    expect(() =>
      synthesize((stack) => ({
        workingDirectories: { Vault: new WorkingDirectory(stack, 'Vault') },
      })),
    ).toThrow(/working directory name "Vault"/);
  });
});
