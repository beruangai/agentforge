/**
 * The kernel's structured-output wire schema is one the backend accepts and
 * the agent can answer, end to end through `runAgent` against a real model.
 * The conversion (`structured-output.ts`) rests on things the SDK's
 * `transformJSONSchema` and the backend do not document together, and either
 * can move: `enum` and `const` kept as constraints after the transform folded
 * them into prose, a `format` sent as-is (TrendBot once found the backend
 * refusing `uri`; it accepted it on 2026-09-25), and a root union nested under
 * one property when a run opts in. One contract carries all of them.
 *
 * What is asserted holds whichever branch the model picks: the run completes,
 * and its answer parses against the declared contract — which `runAgent` does
 * before it returns.
 */
import { describe, expect, it, onTestFinished } from 'vitest';
import { z } from 'zod';
import { runAgent } from '../../../src/server/harness/kernel.ts';
import {
  createSandbox,
  createSubscriptionEnvironment,
} from '../../__fixtures__/claude-agent-sdk.ts';

const FindingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LINK'),
    url: z.url().describe('The address the text refers to'),
    severity: z.enum(['LOW', 'HIGH']),
  }),
  z.object({
    kind: z.literal('NONE'),
    reason: z.string(),
  }),
]);

describe('the structured-output wire schema', () => {
  it('is accepted and answered: a wrapped root union, with const, enum and a format', async () => {
    const sandbox = createSandbox('structured-output-wire-schema');
    onTestFinished(() => sandbox.dispose());

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
          cwd: sandbox.workingDirectory,
          env: createSubscriptionEnvironment(sandbox.configDirectory),
          model: 'claude-sonnet-5',
          maxTurns: 3,
          tools: [],
        },
      },
      { signal: new AbortController().signal, onRecord: () => undefined },
    );

    expect(FindingSchema.parse(run.output)).toEqual(run.output);
  });
});
