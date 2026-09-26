import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { runSessionStoreConformance } from './__fixtures__/session-store-conformance.ts';
import {
  S3SessionStore,
  sessionStoreFromEnvironment,
} from './session-store.ts';

/** An in-memory S3 that honours `Prefix` and `Delimiter`, as the SDK's own adapter test does. */
function inMemoryS3(): { client: S3Client; objects: Map<string, string> } {
  const objects = new Map<string, string>();
  const client = {
    async send(command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) {
      const { input } = command;
      switch (command.constructor.name) {
        case 'PutObjectCommand':
          objects.set(input.Key as string, input.Body as string);
          return {};
        case 'GetObjectCommand': {
          const body = objects.get(input.Key as string);
          return {
            Body:
              body === undefined
                ? undefined
                : { transformToString: async () => body },
          };
        }
        case 'ListObjectsV2Command': {
          const prefix = (input.Prefix as string | undefined) ?? '';
          const delimiter = input.Delimiter as string | undefined;
          return {
            Contents: [...objects.keys()]
              .filter((key) => key.startsWith(prefix))
              .filter(
                (key) =>
                  delimiter === undefined ||
                  !key.slice(prefix.length).includes(delimiter),
              )
              .map((Key) => ({ Key })),
          };
        }
        default:
          throw new Error(`unexpected ${command.constructor.name}`);
      }
    },
  } as unknown as S3Client;
  return { client, objects };
}

const KEY = { projectKey: 'project', sessionId: 'session' };

describe('S3SessionStore', () => {
  describe('conformance', () => {
    runSessionStoreConformance(
      () => new S3SessionStore({ bucket: 'b', client: inMemoryS3().client }),
    );
  });

  it('writes each append as one part under the session', async () => {
    const { client, objects } = inMemoryS3();
    const store = new S3SessionStore({ bucket: 'b', client });
    await store.append(KEY, [{ type: 'user' }]);
    expect([...objects.keys()]).toEqual([
      expect.stringMatching(
        /^project\/session\/part-\d{13}-[0-9a-f]{6}\.jsonl$/,
      ),
    ]);
  });

  it('keeps an entry the SDK re-delivered on a retried batch once', async () => {
    const { client } = inMemoryS3();
    const store = new S3SessionStore({ bucket: 'b', client });
    await store.append(KEY, [{ type: 'user', uuid: 'u1' }]);
    await store.append(KEY, [
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'u2' },
    ]);
    expect(await store.load(KEY)).toEqual([
      { type: 'user', uuid: 'u1' },
      { type: 'assistant', uuid: 'u2' },
    ]);
  });

  it('fails a load over a line that is not JSON', async () => {
    const { client, objects } = inMemoryS3();
    const store = new S3SessionStore({ bucket: 'b', client });
    objects.set('project/session/part-0000000000001-000000.jsonl', '{"type"\n');
    await expect(store.load(KEY)).rejects.toThrow(/not JSON/);
  });
});

describe('sessionStoreFromEnvironment', () => {
  it('declares no store where no bucket is named', () => {
    expect(sessionStoreFromEnvironment({})).toBeUndefined();
  });

  it('stores in the bucket the construct names', () => {
    expect(
      sessionStoreFromEnvironment({
        AGENTFORGE_SESSION_BUCKET: 'bucket',
        AWS_REGION: 'us-east-2',
      }),
    ).toBeInstanceOf(S3SessionStore);
  });
});
