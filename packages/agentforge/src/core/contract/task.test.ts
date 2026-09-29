import { describe, expect, it } from 'vitest';
import { EnvelopeSchema } from './envelope.ts';
import { MAX_TIME_BUDGET_SECONDS } from './procedures.ts';
import { CauseSchema, cause, outcomeOfArtifacts } from './task.ts';

describe('the outcome artifact', () => {
  it('carries the outcome as its one data part', () => {
    expect(
      outcomeOfArtifacts([
        { artifactId: 'other', parts: [{ text: 'not this' }] },
        {
          artifactId: 'outcome',
          parts: [{ data: { state: 'TASK_STATE_CANCELED' } }],
        },
      ]),
    ).toEqual({ state: 'TASK_STATE_CANCELED' });
  });

  it('is absent while the task runs, and refused when ambiguous', () => {
    expect(outcomeOfArtifacts(undefined)).toBeUndefined();
    expect(() =>
      outcomeOfArtifacts([{ artifactId: 'outcome', parts: [] }]),
    ).toThrow(/0 data parts/);
  });
});

describe('a cause', () => {
  it('says when to retry as an ISO time', () => {
    const limited = cause('USAGE_LIMITED', 'limited', {
      retryAfter: new Date(0).toISOString(),
    });
    expect(CauseSchema.parse(limited)).toEqual(limited);
    expect(
      CauseSchema.safeParse({ ...limited, retryAfter: 'after lunch' }).success,
    ).toBe(false);
  });
});

describe('the envelope', () => {
  it('takes a time budget the executor can enforce, in whole seconds', () => {
    const envelope = {
      procedure: 'summarise',
      contractHash: 'hash',
      input: {},
      idempotencyKey: 'key',
    };
    for (const timeBudgetSeconds of [1.5, 0, MAX_TIME_BUDGET_SECONDS + 1]) {
      expect(
        EnvelopeSchema.safeParse({ ...envelope, timeBudgetSeconds }).success,
      ).toBe(false);
    }
    expect(
      EnvelopeSchema.parse({
        ...envelope,
        timeBudgetSeconds: MAX_TIME_BUDGET_SECONDS,
      }).timeBudgetSeconds,
    ).toBe(MAX_TIME_BUDGET_SECONDS);
  });
});
