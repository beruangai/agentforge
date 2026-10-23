import { S3FilesystemBucket } from '@beruangai/agentforge/infra';
import { ResearchBrief } from '@beruangai/common-constructs';
import { CfnOutput, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export class ApplicationStack extends Stack {
  readonly researchBrief: ResearchBrief;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    // A test deployment: `destroy` removes everything, its buckets emptied
    // first (scripts/empty-buckets.ts). A consumer's keeps the default, RETAIN.
    const removalPolicy = RemovalPolicy.DESTROY;
    // The bucket the briefer's documents filesystem mounts from, a corpus per prefix.
    const documents = new S3FilesystemBucket(this, 'Documents', {
      removalPolicy,
    });
    this.researchBrief = new ResearchBrief(this, 'ResearchBrief', {
      removalPolicy,
      agents: {
        briefer: {
          filesystems: { documents },
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

    // Where the suite finds the glossary, under `briefer/memory/`.
    new CfnOutput(this, 'SessionBucketName', {
      value: this.researchBrief.resources.sessionBucket.bucketName,
    });
    // Where the suite uploads a corpus, under `corpora/`.
    new CfnOutput(this, 'DocumentsBucketName', {
      value: documents.bucket.bucketName,
    });
  }
}
