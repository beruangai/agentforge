/**
 * A run with a session store mirrors its whole transcript before the stream
 * ends, and each assistant message the stream carries is a transcript entry
 * with the same uuid — which the kernel's check that the mirror is complete
 * rests on (ADR 0011). The SDK documents the mirror as best-effort and says
 * nothing of either; if a release changes them, `runAgent` fails every run
 * with a store, and this is what says so first.
 *
 * Seen on 2026-09-27: one batch as the result arrives, one more during the
 * drain after it.
 */
import {
  InMemorySessionStore,
  type SessionKey,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../../../src/server/harness/kernel.ts';
import {
  createSandbox,
  createSubscriptionEnvironment,
} from '../../__fixtures__/claude-agent-sdk.ts';

describe('a run with a session store', () => {
  it('mirrors every assistant message before the run returns', async () => {
    const sandbox = createSandbox('session-store-mirror');
    onTestFinished(() => sandbox.dispose());
    const store = new InMemorySessionStore();
    const keys: SessionKey[] = [];
    const append = store.append.bind(store);
    store.append = async (key, entries) => {
      keys.push(key);
      await append(key, entries);
    };

    // Throws if the store lacks any assistant message the stream carried.
    const run = await runAgent(
      {
        prompt: 'Answer yes.',
        output: z.object({ answer: z.string() }),
        options: {
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: 'claude-haiku-4-5',
          maxTurns: 3,
          tools: [],
          sessionStore: store,
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
    );

    const main = keys.find((key) => key.subpath === undefined);
    if (main === undefined) throw new Error('nothing reached the store');
    expect(main.sessionId).toBe(run.sessionId);
    expect(await store.load(main)).not.toBeNull();
  });
});
