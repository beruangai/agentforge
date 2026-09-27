import { RemovalPolicy } from 'aws-cdk-lib';
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
  type BucketProps,
} from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { suppressRules } from './checkov.ts';

export interface WorkingDirectoryProps
  extends Omit<
    BucketProps,
    'encryption' | 'encryptionKey' | 'bucketKeyEnabled'
  > {}

/**
 * A working directory: a bucket its agents' procedures sync prefixes of into
 * a task's own directory (ADR 0015). It is its own construct so that several
 * agents can share it — give each `AgentRuntime` it under a name. Private,
 * TLS-only and versioned — so a push or a delete can be undone — unless
 * declared otherwise; kept when the stack deletes it unless `removalPolicy`
 * says otherwise. How long an overwritten version is kept is the consumer's,
 * as `lifecycleRules`. Its encryption is S3-managed and cannot be changed: no
 * KMS anywhere, for now.
 */
export class WorkingDirectory extends Construct {
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: WorkingDirectoryProps = {}) {
    super(scope, id);
    for (const refused of ['encryption', 'encryptionKey', 'bucketKeyEnabled']) {
      if (refused in props) {
        throw new Error(
          `WorkingDirectory's encryption is S3-managed: no KMS, for now; remove ${refused}`,
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
    if (props.serverAccessLogsBucket === undefined) {
      suppressRules(
        this.bucket,
        ['CKV_AWS_18'],
        'Only the agents given it read and write it, through their own roles; a consumer that needs access logs passes serverAccessLogsBucket.',
      );
    }
  }
}
