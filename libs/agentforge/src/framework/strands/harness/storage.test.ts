import { InMemoryStorage } from '@strands-agents/sdk/storage';
import { describe, expect, it, vi } from 'vitest';
import { recordingStorage, storageFromEnvironment } from './storage.ts';

describe('storageFromEnvironment', () => {
  it('is none without a session bucket', () => {
    expect(storageFromEnvironment({})).toBeUndefined();
  });

  it("keeps the agent's storage in the bucket under its name", () => {
    expect(
      storageFromEnvironment({
        AGENTFORGE_SESSION_BUCKET: 'sessions',
        AGENTFORGE_AGENT_NAME: 'writer',
        AWS_REGION: 'us-east-2',
      }),
    ).toMatchObject({ bucket: 'sessions', agent: 'writer' });
  });

  it('refuses a bucket without the agent name', () => {
    expect(() =>
      storageFromEnvironment({ AGENTFORGE_SESSION_BUCKET: 'sessions' }),
    ).toThrow('AGENTFORGE_AGENT_NAME is unset');
  });
});

describe('recordingStorage', () => {
  it('passes reads and writes through', async () => {
    const inner = new InMemoryStorage();
    const storage = recordingStorage(inner, () => {
      throw new Error('unexpected');
    });
    await storage.write('a/b', new TextEncoder().encode('x'));
    expect(
      new TextDecoder().decode((await inner.read('a/b')) ?? undefined),
    ).toBe('x');
    expect(await storage.list('a/')).toEqual(['a/b']);
  });

  it.each(['write', 'read', 'list'] as const)(
    'reports a failed %s, and still throws it',
    async (operation) => {
      const failure = new Error('AccessDenied');
      const inner = new InMemoryStorage();
      vi.spyOn(inner, operation).mockRejectedValueOnce(failure);
      const onFailed = vi.fn();
      const storage = recordingStorage(inner, onFailed);
      const call = {
        write: () => storage.write('k', new Uint8Array()),
        read: () => storage.read('k'),
        list: () => storage.list('k'),
      }[operation];
      await expect(call()).rejects.toBe(failure);
      expect(onFailed).toHaveBeenCalledWith(
        operation,
        expect.any(String),
        failure,
      );
    },
  );

  it('reads a missing key as null, which is not a failure', async () => {
    const onFailed = vi.fn();
    expect(
      await recordingStorage(new InMemoryStorage(), onFailed).read('absent'),
    ).toBeNull();
    expect(onFailed).not.toHaveBeenCalled();
  });
});
