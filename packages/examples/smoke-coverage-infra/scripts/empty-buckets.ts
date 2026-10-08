// Empties smoke-coverage's versioned buckets — every version and delete marker —
// so `destroy` can delete them: CloudFormation deletes only an empty bucket.
// Reads the bucket names from the outputs the last `deploy` wrote.

import { readFile } from 'node:fs/promises';
import {
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';

const STACK_NAME = 'agentforge-example-smoke-coverage-Application';
const BUCKET_OUTPUTS = [
  'HelloAgentSessionBucketName',
  'NotebookBucketName',
  'MemoriesBucketName',
] as const;

const outputsPath = process.argv[2];
if (outputsPath === undefined) {
  throw new Error('usage: empty-buckets.ts <deploy outputs.json>');
}
const OutputsSchema = z.object({
  [STACK_NAME]: z.object({
    HelloAgentSessionBucketName: z.string(),
    NotebookBucketName: z.string(),
    MemoriesBucketName: z.string(),
  }),
});
const outputs = OutputsSchema.safeParse(
  JSON.parse(await readFile(outputsPath, 'utf8')),
);
if (!outputs.success) {
  throw new Error(
    `${outputsPath} does not name ${BUCKET_OUTPUTS.join(', ')}; redeploy first: ${z.prettifyError(outputs.error)}`,
  );
}
const stackOutputs = outputs.data[STACK_NAME];

const s3 = new S3Client({});
for (const output of BUCKET_OUTPUTS) {
  const bucket = stackOutputs[output];
  let deleted = 0;
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    );
    const objects = [
      ...(page.Versions ?? []),
      ...(page.DeleteMarkers ?? []),
    ].map(({ Key, VersionId }) => {
      if (Key === undefined || VersionId === undefined) {
        throw new Error(`${bucket} listed a version with no key or id`);
      }
      return { Key, VersionId };
    });
    if (objects.length > 0) {
      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
      if (result.Errors !== undefined && result.Errors.length > 0) {
        throw new Error(
          `${bucket}: ${result.Errors.length} versions were not deleted, the first ${result.Errors[0]?.Key}: ${result.Errors[0]?.Message}`,
        );
      }
      deleted += objects.length;
    }
    keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
    versionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
  } while (keyMarker !== undefined);
  console.log(`${bucket}: ${deleted} versions and delete markers deleted`);
}
