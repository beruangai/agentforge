import type { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { readTranscript } from './transcript.ts';

const LOCATION = { bucket: 'sessions', agent: 'writer', projectKey: 'project' };
/** The SDK reads a session only by a UUID. */
const SESSION_ID = '2b7f0e4c-1d2a-4c55-9a51-5b0c9f6a3e11';

/** An S3 holding `objects`, answering a listing by prefix and a get by key. */
function s3Holding(objects: Record<string, string>): S3Client {
  return {
    async send(command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) {
      const { input } = command;
      if (command.constructor.name === 'ListObjectsV2Command') {
        const prefix = input.Prefix as string;
        return {
          Contents: Object.keys(objects)
            .filter((key) => key.startsWith(prefix))
            .map((Key) => ({ Key })),
        };
      }
      const body = objects[input.Key as string];
      return { Body: body && { transformToString: async () => body } };
    },
  } as unknown as S3Client;
}

describe('readTranscript', () => {
  it('reads the session at the recorded key as the SDK sees it', async () => {
    const entry = (
      uuid: string,
      parentUuid: string | null,
      role: 'user' | 'assistant',
    ) => ({
      type: role,
      uuid,
      parentUuid,
      sessionId: SESSION_ID,
      timestamp: '2026-10-14T00:00:00.000Z',
      message: { role, content: [{ type: 'text', text: uuid }] },
    });
    const client = s3Holding({
      [`writer/project/${SESSION_ID}/part-0000000000001-aaaaaa.jsonl`]: `${[
        entry('u1', null, 'user'),
        entry('a1', 'u1', 'assistant'),
      ]
        .map((line) => JSON.stringify(line))
        .join('\n')}\n`,
    });
    const messages = await readTranscript(
      { sessionId: SESSION_ID, transcript: LOCATION },
      { client },
    );
    expect(messages.map((message) => message.uuid)).toEqual(['u1', 'a1']);
  });

  it('refuses a run that records no transcript, and names the key that holds none', async () => {
    await expect(readTranscript({ sessionId: SESSION_ID })).rejects.toThrow(
      /records no transcript/,
    );
    await expect(
      readTranscript(
        { sessionId: SESSION_ID, transcript: LOCATION },
        { client: s3Holding({}) },
      ),
    ).rejects.toThrow(
      `no transcript at s3://sessions/writer/project/${SESSION_ID}/`,
    );
  });
});
