/**
 * A bucket that exists for one run of the suite, and the credentials the
 * container needs to reach it.
 *
 * **Per run, not long-lived.** A standing bucket would be shared state: two
 * runs at once would need prefixes to stay apart, and anything changed on it
 * between runs — versioning, a lifecycle rule, a default checksum — would
 * change what `--delete` and the checksum check observe without the test
 * saying so. A bucket created with S3's defaults for this run measures those
 * defaults, and removing it leaves nothing behind. It is tagged
 * `agentforge:integ=true` at creation, atomically, so a run killed before its
 * teardown leaves a bucket the tag finds. The objects inside are not tagged
 * individually: tagging them would mean passing `--tagging` to the very
 * commands under test, and they cannot outlive the bucket that holds them.
 */
import { createHash } from 'node:crypto';
import {
  type BucketLocationConstraint,
  ChecksumMode,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';

export const integTag = { Key: 'agentforge:integ', Value: 'true' } as const;

export interface AwsForContainer {
  s3: S3Client;
  region: string;
  accountId: string;
  /**
   * Resolved on the host through the SDK's own credential chain — the
   * `AWS_PROFILE` Nx loads from `.env.integ` — and handed to the container as
   * plain environment variables, which is the one source every SDK reads
   * first. The container has no profile configuration of its own.
   */
  containerEnvironment: Record<string, string>;
}

export async function resolveAwsForContainer(): Promise<AwsForContainer> {
  const s3 = new S3Client({});
  const region = await s3.config.region();
  const credentials = await s3.config.credentials();
  const identity = await new STSClient({ region }).send(
    new GetCallerIdentityCommand({}),
  );
  if (identity.Account === undefined) {
    throw new Error('STS GetCallerIdentity returned no Account');
  }
  const containerEnvironment: Record<string, string> = {
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_REGION: region,
  };
  if (credentials.sessionToken !== undefined) {
    containerEnvironment.AWS_SESSION_TOKEN = credentials.sessionToken;
  }
  return { s3, region, accountId: identity.Account, containerEnvironment };
}

/**
 * `agentforge-integ-{account}-{run id without hyphens}` — 62 characters, inside
 * S3's 63. The account id comes from STS, never from the source.
 */
export async function createScratchBucket(
  aws: AwsForContainer,
  runId: string,
): Promise<string> {
  const bucketName = `agentforge-integ-${aws.accountId}-${runId.replaceAll('-', '')}`;
  await aws.s3.send(
    new CreateBucketCommand({
      Bucket: bucketName,
      CreateBucketConfiguration: {
        // us-east-1 is the one region S3 refuses as an explicit constraint.
        ...(aws.region === 'us-east-1'
          ? {}
          : { LocationConstraint: aws.region as BucketLocationConstraint }),
        Tags: [integTag],
      },
    }),
  );
  return bucketName;
}

/** Every key under `prefix`, with the prefix removed, sorted. */
export async function listRelativeKeys(
  s3: S3Client,
  bucketName: string,
  prefix: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const page of paginateListObjectsV2(
    { client: s3 },
    { Bucket: bucketName, Prefix: prefix },
  )) {
    for (const object of page.Contents ?? []) {
      if (object.Key === undefined) {
        throw new Error(
          `ListObjectsV2 on ${bucketName} returned an unkeyed object`,
        );
      }
      keys.push(object.Key.slice(prefix.length));
    }
  }
  return keys.sort();
}

/** The SHA256 S3 stored for `key`, as the base64 the API reports. */
export async function readStoredSha256(
  s3: S3Client,
  bucketName: string,
  key: string,
): Promise<string | undefined> {
  const head = await s3.send(
    new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
      ChecksumMode: ChecksumMode.ENABLED,
    }),
  );
  return head.ChecksumSHA256;
}

export function sha256Base64(content: Buffer): string {
  return createHash('sha256').update(content).digest('base64');
}

/**
 * Empties and deletes the bucket. `DeleteObjects` answers 200 with per-key
 * errors, so those are read rather than trusted; anything that fails throws
 * naming the bucket and whatever is still in it.
 */
export async function deleteScratchBucket(
  s3: S3Client,
  bucketName: string,
): Promise<void> {
  try {
    const keys = await listRelativeKeys(s3, bucketName, '');
    for (let start = 0; start < keys.length; start += 1000) {
      const response = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: {
            Objects: keys
              .slice(start, start + 1000)
              .map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );
      if (response.Errors !== undefined && response.Errors.length > 0) {
        throw new Error(
          `DeleteObjects refused ${response.Errors.map((error) => `${error.Key} (${error.Code})`).join(', ')}`,
        );
      }
    }
    await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const remaining = await listRelativeKeys(s3, bucketName, '').then(
      (keys) => (keys.length > 0 ? keys.join(', ') : 'no objects'),
      (listError: unknown) => `unlistable: ${String(listError)}`,
    );
    throw new Error(
      `Teardown left s3://${bucketName} (tagged ${integTag.Key}=${integTag.Value}) — ${remaining}`,
      { cause: error },
    );
  }
}
