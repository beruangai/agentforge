import { App, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { describe, expect, it } from 'vitest';
import {
  TASK_TABLE_PARTITION_KEY,
  TASK_TABLE_TIME_TO_LIVE_ATTRIBUTE,
} from '#core/task-table.ts';
import { AgentRuntime } from './agent-runtime.ts';
import {
  AgenticProjectResources,
  type AgenticProjectResourcesProps,
} from './agentic-project-resources.ts';

/** A project with an agent per name, each in its own construct. */
function synthesize(
  agentNames: readonly string[] = ['writer', 'grader'],
  props: Partial<AgenticProjectResourcesProps> = {},
): Template {
  const stack = new Stack(new App(), 'Project', {
    env: { account: '123456789012', region: 'us-east-2' },
  });
  const project = new AgenticProjectResources(stack, 'Resources', {
    projectName: 'golden-kata',
    ...props,
  });
  const token = Secret.fromSecretNameV2(
    stack,
    'Token',
    'agentforge/claude-code-oauth-token',
  );
  agentNames.forEach((agentName, index) => {
    new AgentRuntime(stack, `Agent${index}`, {
      project,
      agentName,
      agentRuntimeArtifact: AgentRuntimeArtifact.fromImageUri(
        `123456789012.dkr.ecr.us-east-2.amazonaws.com/${agentName}:latest`,
      ),
      secrets: { CLAUDE_CODE_OAUTH_TOKEN: token },
    });
  });
  return Template.fromStack(stack);
}

describe('AgenticProjectResources', () => {
  it("gives a project's agents one table, one bucket, one dashboard with a section each, and one probe that checks each", () => {
    const template = synthesize();
    template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 2);
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    // The probe is the only function: no provider outlives the stack.
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.resourceCountIs('Custom::AgentForgeReadiness', 2);
    const body = JSON.stringify(
      template.findResources('AWS::CloudWatch::Dashboard'),
    );
    expect(body).toContain('# golden-kata');
    expect(body).toContain('## writer');
    expect(body).toContain('## grader');
    expect(body).toContain('TasksLost');
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

  it('persists session transcripts in a private, encrypted, versioned, retained bucket, expired after 30 days', () => {
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
  });

  it('keeps every agent’s transcripts as long as the consumer chooses for the project, and removes as it says', () => {
    const template = synthesize(['writer'], {
      sessionRetention: Duration.days(365),
      removalPolicy: RemovalPolicy.DESTROY,
    });
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        LifecycleConfiguration: {
          Rules: Match.arrayWith([Match.objectLike({ ExpirationInDays: 365 })]),
        },
      }),
    });
    template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  });

  it('refuses two agents under one name', () => {
    expect(() => synthesize(['writer', 'writer'])).toThrow(
      /already has an agent named "writer"/,
    );
  });
});
