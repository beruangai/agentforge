import { readdir, readFile } from 'node:fs/promises';
import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

const CORPUS_DIRECTORY = new URL('./corpus/', import.meta.url);

/** A question the corpus answers only from all three of its documents. */
export const QUESTION =
  'Which generates more reliably over a year, tidal stream or offshore wind, and how does storage help with curtailment?';

/** The corpus fixture's documents, by name. */
export async function corpusDocuments(): Promise<Map<string, string>> {
  const names = await readdir(CORPUS_DIRECTORY);
  return new Map(
    await Promise.all(
      names.map(
        async (name) =>
          [
            name,
            await readFile(new URL(name, CORPUS_DIRECTORY), 'utf8'),
          ] as const,
      ),
    ),
  );
}

/** Uploads the documents as the corpus `corpus`, where the documents filesystem reads it. */
export async function uploadCorpus(
  s3: S3Client,
  bucket: string,
  corpus: string,
  documents: ReadonlyMap<string, string>,
): Promise<void> {
  for (const [name, text] of documents) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `corpora/${corpus}/${name}`,
        Body: text,
      }),
    );
  }
}
