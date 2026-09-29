/**
 * A bucket that exists for one run of the suite. Per run, not long-lived: a
 * bucket created with S3's defaults measures those defaults, and removing it
 * leaves nothing behind. Tagged at creation, so a run killed before its
 * teardown leaves a bucket the tag finds.
 */
import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  paginateListObjectsV2,
  type S3Client,
} from '@aws-sdk/client-s3';
import {
  INTEG_TAG,
  resolveCallerIdentity,
} from '../../__fixtures__/aws-account.ts';

/**
 * `agentforge-integ-{account}-{run id without hyphens}` — 62 characters,
 * inside S3's 63. The account id comes from STS, never from the source.
 */
export async function createScratchBucket(
  s3: S3Client,
  runId: string,
): Promise<string> {
  const region = await s3.config.region();
  const { accountId } = await resolveCallerIdentity(region);
  const bucketName = `agentforge-integ-${accountId}-${runId.replaceAll('-', '')}`;
  await s3.send(
    new CreateBucketCommand({
      Bucket: bucketName,
      CreateBucketConfiguration: {
        // us-east-1 is the one region S3 refuses as an explicit constraint.
        ...(region === 'us-east-1'
          ? {}
          : { LocationConstraint: region as BucketLocationConstraint }),
        Tags: [INTEG_TAG],
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

/**
 * Empties and deletes the bucket. `DeleteObjects` answers 200 with per-key
 * errors, so those are read rather than trusted.
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
    throw new Error(
      `Teardown left s3://${bucketName} (tagged ${INTEG_TAG.Key}=${INTEG_TAG.Value})`,
      { cause: error },
    );
  }
}
