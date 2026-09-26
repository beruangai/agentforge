import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentRuntimeArtifact } from 'aws-cdk-lib/aws-bedrockagentcore';
import { BucketEncryption } from 'aws-cdk-lib/aws-s3';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from './agent-runtime.ts';
import { WorkingDirectory } from './working-directory.ts';

describe('WorkingDirectory', () => {
  it('is a private, S3-encrypted, retained bucket that several agents share', () => {
    const stack = new Stack(new App(), 'Agents', {
      env: { account: '123456789012', region: 'us-east-2' },
    });
    const vault = new WorkingDirectory(stack, 'Vault');
    for (const name of ['One', 'Two']) {
      new AgentRuntime(stack, name, {
        agentRuntimeArtifact: AgentRuntimeArtifact.fromImageUri(
          '123456789012.dkr.ecr.us-east-2.amazonaws.com/agent:latest',
        ),
        workingDirectories: { vault },
      });
    }
    const template = Template.fromStack(stack);
    const buckets = template.findResources('AWS::S3::Bucket');
    const [id, bucket] = Object.entries(buckets).find(([key]) =>
      key.startsWith('VaultBucket'),
    ) ?? [undefined, undefined];
    expect(bucket).toMatchObject({
      DeletionPolicy: 'Retain',
      Properties: {
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
      },
    });
    // One bucket, and both agents' policies grant on it.
    expect(
      Object.values(template.findResources('AWS::IAM::Policy')).filter(
        (policy) => JSON.stringify(policy).includes(`"${id}"`),
      ),
    ).toHaveLength(2);
  });

  it('refuses an encryption whose ETags are not MD5s', () => {
    const stack = new Stack(new App(), 'Agents');
    expect(
      () =>
        new WorkingDirectory(stack, 'Vault', {
          encryption: BucketEncryption.KMS,
        } as never),
    ).toThrow(/remove encryption/);
  });
});
