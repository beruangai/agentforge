/**
 * A context block's cache breakpoint becomes a cache point the provider
 * honours: a second run with the same prefix reads it. The placement is
 * AgentForge's (no `cacheConfig`), and both Strands' rendering and the
 * provider's caching can move.
 *
 * The prefix carries a nonce, so the first run writes and only the second
 * can read, whatever ran before.
 */
import { randomUUIDv7 } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../../../src/framework/strands/harness/runner.ts';
import {
  STRANDS_INTEG_MODEL,
  strandsRunnerContext,
} from '../../__fixtures__/strands-runner-context.ts';

/** Comfortably over the smallest cacheable prefix of any current model. */
const RULES = Array.from(
  { length: 900 },
  (_, line) =>
    `Rule ${line}: a reply names the rule it follows, by its number.`,
).join('\n');

describe('strands cache points, on a real model', () => {
  it('are read by a second run with the same prefix', async () => {
    const context = {
      tag: 'rules',
      context: `${randomUUIDv7()}\n${RULES}`,
      cache: true,
    } as const;
    const ask = (question: string) =>
      runAgent(
        {
          prompt: [context, question],
          output: z.object({ rule: z.number() }),
          options: {
            model: STRANDS_INTEG_MODEL,
            maxTokens: 512,
            limits: { turns: 3 },
          },
        },
        { signal: new AbortController().signal, onRecord: () => undefined },
        strandsRunnerContext(),
      );
    const first = await ask('Which rule number comes first?');
    const second = await ask('Which rule number comes last?');
    expect(first.usage.cacheCreationInputTokens).toBeGreaterThan(0);
    expect(second.usage.cacheReadInputTokens).toBeGreaterThan(0);
  });
});
