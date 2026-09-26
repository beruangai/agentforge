import { RemovalPolicy } from 'aws-cdk-lib';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  type BucketProps,
} from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export interface WorkingDirectoryProps
  extends Omit<
    BucketProps,
    'encryption' | 'encryptionKey' | 'bucketKeyEnabled'
  > {}

/**
 * A working directory: a bucket its agents' procedures sync prefixes of into
 * a task's own directory (ADR 0015). It is its own construct so that several
 * agents can share it — give each `AgentRuntime` it under a name. Private and
 * TLS-only unless declared otherwise; kept when the stack deletes it unless
 * `removalPolicy` says otherwise. Its encryption is S3-managed and cannot be
 * changed: the sync verifies a push by each object's ETag being its MD5,
 * which a KMS-encrypted object's is not.
 */
export class WorkingDirectory extends Construct {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: WorkingDirectoryProps = {}) {
    super(scope, id);
    for (const refused of ['encryption', 'encryptionKey', 'bucketKeyEnabled']) {
      if (refused in props) {
        throw new Error(
          `WorkingDirectory's encryption is S3-managed, so a push can be verified by its ETags; remove ${refused}`,
        );
      }
    }
    this.bucket = new Bucket(this, 'Bucket', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      ...props,
      encryption: BucketEncryption.S3_MANAGED,
    });
  }
}
