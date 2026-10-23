/**
 * The `strands` runner settles on a real model as it does on the scripted
 * API: a wire schema the provider accepts, and a refusal told in turn that
 * the model answers with a new submission. Both rest on Strands' hook and
 * tool-result behaviour and on the provider's schema handling, which can
 * move with either.
 *
 * What is asserted holds whichever branch the model picks: the run settles,
 * and its answer parses against the declared contract.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../../../src/framework/strands/harness/runner.ts';
import {
  STRANDS_INTEG_MODEL,
  strandsRunnerContext,
} from '../../__fixtures__/strands-runner-context.ts';

const FindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LINK'),
    url: z.url().describe('The address the text refers to'),
    severity: z.enum(['LOW', 'HIGH']),
  }),
  z.object({ kind: z.literal('NONE'), reason: z.string() }),
]);

const environment = () => ({
  signal: new AbortController().signal,
  onRecord: () => undefined,
});

describe('strands structured output, on a real model', () => {
  it('is accepted and answered: a wrapped root union, with const, enum and a format', async () => {
    const run = await runAgent(
      {
        prompt: [
          'Report the one link in the text as a LINK finding of HIGH severity.',
          {
            tag: 'text',
            context: 'The guide lives at https://example.com/guide.',
          },
        ],
        output: FindingSchema,
        wrapNonObjectOutput: true,
        options: {
          model: STRANDS_INTEG_MODEL,
          maxTokens: 1024,
          limits: { turns: 3 },
        },
      },
      environment(),
      strandsRunnerContext(),
    );
    expect(FindingSchema.parse(run.output)).toEqual(run.output);
    expect(run.usage.outputTokens).toBeGreaterThan(0);
  });

  it('answers a refusal told in its turn with a submission that is accepted', async () => {
    let refused = 0;
    const run = await runAgent(
      {
        prompt: 'Name a colour.',
        output: z.object({ colour: z.string() }),
        guardrails: {
          stop: [
            async () =>
              refused++ === 0
                ? {
                    reason: 'Submit again: the first answer is never accepted.',
                  }
                : undefined,
          ],
        },
        options: {
          model: STRANDS_INTEG_MODEL,
          maxTokens: 1024,
          limits: { turns: 4 },
        },
      },
      environment(),
      strandsRunnerContext(),
    );
    expect(refused).toBe(2);
    expect(typeof run.output.colour).toBe('string');
  });
});
