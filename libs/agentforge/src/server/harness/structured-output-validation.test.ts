import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { StopGuard } from './stop-guard.ts';
import { validateStructuredOutput } from './structured-output-validation.ts';

const OutputSchema = z.object({
  answer: z.string(),
  source: z.url(),
});

const VALID = { answer: 'four', source: 'https://example.com/sums' };

describe('validateStructuredOutput', () => {
  it('accepts a submission the contract takes and every guard passes', async () => {
    const guard = vi.fn<StopGuard>(async () => undefined);
    expect(
      await validateStructuredOutput(
        { output: OutputSchema, guards: [guard, guard] },
        VALID,
      ),
    ).toBeUndefined();
    expect(guard).toHaveBeenCalledTimes(2);
  });

  it('refuses what the contract refuses beyond the JSON Schema', async () => {
    const reason = await validateStructuredOutput(
      { output: OutputSchema, guards: [] },
      { ...VALID, source: 'not a url' },
    );
    expect(reason).toMatch(/stricter than the JSON Schema/);
    expect(reason).toMatch(/at source/);
  });

  it('runs every guard though one denies, and tells every failure in one refusal', async () => {
    const later = vi.fn<StopGuard>(async () => ({
      reason: 'Write notes.md before submitting.',
    }));
    const reason = await validateStructuredOutput(
      {
        output: OutputSchema,
        guards: [
          async () => ({ reason: 'Write kata.md before submitting.' }),
          async () => undefined,
          later,
        ],
      },
      { ...VALID, source: 'not a url' },
    );
    expect(later).toHaveBeenCalledOnce();
    expect(reason).toMatch(/at source/);
    expect(reason).toMatch(/- Write kata\.md before submitting\./);
    expect(reason).toMatch(/- Write notes\.md before submitting\./);
    expect(reason?.indexOf('at source')).toBeLessThan(
      reason?.indexOf('kata.md') ?? -1,
    );
  });

  it('rejects with a guard that throws, never refusing with it', async () => {
    const failure = new Error('the guard broke');
    await expect(
      validateStructuredOutput(
        {
          output: OutputSchema,
          guards: [
            async () => {
              throw failure;
            },
          ],
        },
        VALID,
      ),
    ).rejects.toBe(failure);
  });
});
