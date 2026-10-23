import { S3FilesystemBucket } from '@beruangai/agentforge/infra';
import { StrandsSmoke } from '@beruangai/common-constructs';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export class ApplicationStack extends Stack {
  readonly strandsSmoke: StrandsSmoke;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // A test deployment: `destroy` removes everything, its buckets emptied
    // first (scripts/empty-buckets.ts). A consumer's keeps the default, RETAIN.
    const removalPolicy = RemovalPolicy.DESTROY;
    // The bucket hello-agent's notebook filesystem mounts from.
    const notebook = new S3FilesystemBucket(this, 'Notebook', {
      removalPolicy,
    });
    this.strandsSmoke = new StrandsSmoke(this, 'StrandsSmoke', {
      removalPolicy,
      agents: {
        helloAgent: {
          filesystems: { notebook },
          // The operator creates this secret and sets its value.
          secrets: {
            ANTHROPIC_API_KEY: Secret.fromSecretNameV2(
              this,
              'AnthropicApiKey',
              'agentforge/anthropic-api-key',
            ),
          },
        },
      },
    });

    const { helloAgent } = this.strandsSmoke.agents;
    // What the suite expects every task to record as its image.
    new CfnOutput(this, 'HelloAgentImage', { value: helloAgent.image });
    // Where the suite reads a session back from, under `hello-agent/`.
    new CfnOutput(this, 'SessionBucketName', {
      value: this.strandsSmoke.resources.sessionBucket.bucketName,
    });
    new CfnOutput(this, 'NotebookBucketName', {
      value: notebook.bucket.bucketName,
    });
  }
}
