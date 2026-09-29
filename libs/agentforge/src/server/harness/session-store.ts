import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { SESSION_BUCKET_VARIABLE } from '#core/session-store.ts';

const LOAD_CONCURRENCY = 16;

/**
 * Session transcripts in S3, so a session outlives its container and resumes
 * in another (§REQ402). The SDK's reference adapter
 * (anthropics/claude-agent-sdk-typescript `examples/session-stores/s3`, MIT),
 * reduced to what AgentForge uses — `listSubkeys` restores subagent
 * transcripts on resume; the bucket's lifecycle is the retention — and made
 * loud: a line that is not JSON fails the load, and an entry the SDK
 * re-delivered on a retried batch is kept once, by its `uuid`.
 *
 * Each `append` is one part object,
 * `{projectKey}/{sessionId}[/{subpath}]/part-{epochMs13}-{rand6}.jsonl`;
 * `load` lists a key's parts, which sort chronologically, and concatenates.
 */
export class S3SessionStore implements SessionStore {
  private readonly bucket: string;
  private readonly client: S3Client;
  private lastMilliseconds = 0;

  constructor(options: { readonly bucket: string; readonly client: S3Client }) {
    this.bucket = options.bucket;
    this.client = options.client;
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: keyPrefix(key) + this.nextPartName(),
        Body: `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
        ContentType: 'application/x-ndjson',
      }),
    );
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const prefix = keyPrefix(key);
    // A key's own parts only: its subpaths' parts sit one level deeper.
    const parts = (await this.listUnder(prefix, '/'))
      .filter((objectKey) => !objectKey.slice(prefix.length).includes('/'))
      .sort();
    if (parts.length === 0) return null;
    const entries: SessionStoreEntry[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < parts.length; index += LOAD_CONCURRENCY) {
      const bodies = await Promise.all(
        parts.slice(index, index + LOAD_CONCURRENCY).map(async (objectKey) => {
          const object = await this.client.send(
            new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
          );
          if (object.Body === undefined) {
            throw new Error(`s3://${this.bucket}/${objectKey} has no body`);
          }
          return { objectKey, body: await object.Body.transformToString() };
        }),
      );
      for (const { objectKey, body } of bodies) {
        for (const line of body.split('\n')) {
          if (line.trim() === '') continue;
          let entry: SessionStoreEntry;
          try {
            entry = JSON.parse(line) as SessionStoreEntry;
          } catch (error) {
            throw new Error(
              `s3://${this.bucket}/${objectKey} holds a line that is not JSON`,
              { cause: error },
            );
          }
          const uuid = (entry as { uuid?: unknown }).uuid;
          if (typeof uuid === 'string') {
            if (seen.has(uuid)) continue;
            seen.add(uuid);
          }
          entries.push(entry);
        }
      }
    }
    return entries;
  }

  async listSubkeys(key: {
    projectKey: string;
    sessionId: string;
  }): Promise<string[]> {
    const prefix = keyPrefix(key);
    const subkeys = new Set<string>();
    for (const objectKey of await this.listUnder(prefix)) {
      const segments = objectKey.slice(prefix.length).split('/').slice(0, -1);
      if (segments.length === 0) continue;
      // No legitimate writer produces a traversing or empty segment.
      if (
        segments.some(
          (segment) => segment === '..' || segment === '.' || segment === '',
        )
      ) {
        throw new Error(
          `s3://${this.bucket}/${objectKey} is under a subpath that is not a plain relative path`,
        );
      }
      subkeys.add(segments.join('/'));
    }
    return [...subkeys];
  }

  private async listUnder(
    prefix: string,
    delimiter?: string,
  ): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ...(delimiter === undefined ? {} : { Delimiter: delimiter }),
          ...(continuationToken === undefined
            ? {}
            : { ContinuationToken: continuationToken }),
        }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) keys.push(object.Key);
      }
      continuationToken = page.NextContinuationToken;
    } while (continuationToken !== undefined);
    return keys;
  }

  /** Fixed-width epoch milliseconds, so lexical order is chronological. */
  private nextPartName(): string {
    const milliseconds = Math.max(Date.now(), this.lastMilliseconds + 1);
    this.lastMilliseconds = milliseconds;
    const suffix = Math.random().toString(16).slice(2, 8).padStart(6, '0');
    return `part-${milliseconds.toString().padStart(13, '0')}-${suffix}.jsonl`;
  }
}

function keyPrefix(key: SessionKey): string {
  return `${[key.projectKey, key.sessionId, ...(key.subpath === undefined ? [] : [key.subpath])].join('/')}/`;
}

/**
 * The store the construct declares, for every run in this task process; none
 * where no bucket is named, as locally, where transcripts stay in the
 * container.
 */
export function sessionStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): SessionStore | undefined {
  const bucket = environment[SESSION_BUCKET_VARIABLE];
  if (bucket === undefined || bucket === '') return undefined;
  return new S3SessionStore({ bucket, client: new S3Client({}) });
}
