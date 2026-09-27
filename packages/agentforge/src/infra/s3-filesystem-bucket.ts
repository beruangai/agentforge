import { RemovalPolicy } from 'aws-cdk-lib';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  type BucketProps,
} from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface S3FilesystemBucketProps
  extends Omit<
    BucketProps,
    'encryption' | 'encryptionKey' | 'bucketKeyEnabled'
  > {}

/**
 * The bucket behind an `S3Filesystem`: its agents' procedures mount prefixes
 * of it (ADR 0015). It is its own construct so that several agents can share
 * it — give each `AgentRuntime` it under a name. Private,
 * TLS-only and versioned — so a push or a delete can be undone — unless
 * declared otherwise; kept when the stack deletes it unless `removalPolicy`
 * says otherwise. How long an overwritten version is kept is the consumer's,
 * as `lifecycleRules`. Its encryption is S3-managed and cannot be changed: no
 * KMS anywhere, for now.
 */
export class S3FilesystemBucket extends Construct {
  readonly bucket: Bucket;

  constructor(
    scope: Construct,
    id: string,
    props: S3FilesystemBucketProps = {},
  ) {
    super(scope, id);
    for (const refused of ['encryption', 'encryptionKey', 'bucketKeyEnabled']) {
      if (refused in props) {
        throw new Error(
          `S3FilesystemBucket's encryption is S3-managed: no KMS, for now; remove ${refused}`,
        );
      }
    }
    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
      ...props,
      encryption: BucketEncryption.S3_MANAGED,
    });
  }
}
