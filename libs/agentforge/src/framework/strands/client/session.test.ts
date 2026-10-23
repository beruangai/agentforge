import type { S3Client } from '@aws-sdk/client-s3';
import { Message } from '@strands-agents/sdk';
import { describe, expect, it } from 'vitest';
import { latestSnapshotKey } from '../core/session-keys.ts';
import { readSession } from './session.ts';

const STRANDS_FRAMEWORK = {
  name: 'strands',
  fullName: '@strands-agents/sdk@1.22.0',
} as const;
const TRANSCRIPT = { bucket: 'sessions', agent: 'writer' };

/** An S3 holding `objects`, answering a get by key. */
function s3Holding(
  objects: Record<string, string>,
): S3Client & { keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    async send(command: { input: { Key: string } }) {
      keys.push(command.input.Key);
      const body = objects[command.input.Key];
      if (body === undefined) {
        throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      }
      return {
        Body: {
          transformToByteArray: async () => new TextEncoder().encode(body),
        },
      };
    },
  } as unknown as S3Client & { keys: string[] };
}

describe('readSession', () => {
  it("reads the session's latest snapshot as Strands' messages", async () => {
    const key = `writer/${latestSnapshotKey('s1')}`;
    const client = s3Holding({
      [key]: JSON.stringify({
        data: {
          messages: [
            { role: 'user', content: [{ text: 'hello' }] },
            { role: 'assistant', content: [{ text: 'hi' }] },
          ],
        },
      }),
    });
    const messages = await readSession(
      { framework: STRANDS_FRAMEWORK, sessionId: 's1', transcript: TRANSCRIPT },
      { client },
    );
    expect(client.keys).toEqual([key]);
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(messages[0]).toBeInstanceOf(Message);
  });

  it("refuses another framework's run", async () => {
    await expect(
      readSession({
        framework: { name: 'claude', fullName: 'x' },
        sessionId: 's1',
        transcript: TRANSCRIPT,
      }),
    ).rejects.toThrow('its own client reads its session');
  });

  it('refuses a run that records no session', async () => {
    await expect(
      readSession({ framework: STRANDS_FRAMEWORK, sessionId: 's1' }),
    ).rejects.toThrow('records no session');
  });

  it('fails naming the key when no session is there', async () => {
    await expect(
      readSession(
        {
          framework: STRANDS_FRAMEWORK,
          sessionId: 's1',
          transcript: TRANSCRIPT,
        },
        { client: s3Holding({}) },
      ),
    ).rejects.toThrow(
      `no session at s3://sessions/writer/${latestSnapshotKey('s1')}`,
    );
  });
});
