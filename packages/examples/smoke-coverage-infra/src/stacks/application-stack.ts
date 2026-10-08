import { S3FilesystemBucket } from '@beruangai/agentforge/infra';
import { SmokeCoverage } from '@beruangai/common-constructs';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export class ApplicationStack extends Stack {
  readonly smokeCoverage: SmokeCoverage;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // A test deployment: `destroy` removes everything, its buckets emptied
    // first (scripts/empty-buckets.ts). A consumer's keeps the default, RETAIN.
    const removalPolicy = RemovalPolicy.DESTROY;
    // The bucket hello-agent's notebook filesystem mounts from.
    const notebook = new S3FilesystemBucket(this, 'Notebook', {
      removalPolicy,
    });
    // The bucket hello-agent's memory spaces mount from.
    const memories = new S3FilesystemBucket(this, 'Memories', {
      removalPolicy,
    });
    this.smokeCoverage = new SmokeCoverage(this, 'SmokeCoverage', {
      removalPolicy,
      agents: {
        helloAgent: {
          filesystems: { notebook, memories },
          // The operator creates this secret and sets its value.
          secrets: {
            CLAUDE_CODE_OAUTH_TOKEN: Secret.fromSecretNameV2(
              this,
              'SubscriptionToken',
              'agentforge/claude-code-oauth-token',
            ),
          },
        },
      },
    });

    const { helloAgent } = this.smokeCoverage.agents;
    // What the smoke suite stops a container through, and lists transcripts in.
    new CfnOutput(this, 'HelloAgentRuntimeArn', {
      value: helloAgent.agentRuntimeArn,
    });
    // What the smoke suite expects every task to record as its image.
    new CfnOutput(this, 'HelloAgentImage', { value: helloAgent.image });
    new CfnOutput(this, 'SessionBucketName', {
      value: this.smokeCoverage.resources.sessionBucket.bucketName,
    });
    new CfnOutput(this, 'NotebookBucketName', {
      value: notebook.bucket.bucketName,
    });
    new CfnOutput(this, 'MemoriesBucketName', {
      value: memories.bucket.bucketName,
    });
  }
}
