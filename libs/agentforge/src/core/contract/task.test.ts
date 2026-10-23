import { describe, expect, it } from 'vitest';
import { EnvelopeSchema } from './envelope.ts';
import { MAX_TIME_BUDGET_SECONDS } from './procedures.ts';
import {
  CauseSchema,
  cause,
  outcomeOfArtifacts,
  RunRecordSchema,
} from './task.ts';

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

  it('suggests an action that names no framework, unless one is given', () => {
    expect(cause('CREDENTIAL_EXPIRED', 'expired').suggestedAction).toBe(
      "An operator renews the framework's credential and updates the agent's secret; a retry cannot succeed before that.",
    );
    expect(
      cause('CREDENTIAL_EXPIRED', 'expired', { suggestedAction: 'Renew it.' })
        .suggestedAction,
    ).toBe('Renew it.');
  });
});

describe('a run record', () => {
  const record = {
    framework: { name: 'claude', fullName: 'sdk@1' },
    promptHash: 'hash',
    promptBytes: 1,
    options: {},
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  };

  it('parses without a cost, as from a framework that reports none', () => {
    expect(RunRecordSchema.parse(record)).toEqual(record);
  });

  it('names a provided framework, and no other', () => {
    expect(
      RunRecordSchema.safeParse({
        ...record,
        framework: { name: 'langgraph', fullName: 'sdk@1' },
      }).success,
    ).toBe(false);
    const { framework: _, ...nameless } = record;
    expect(RunRecordSchema.safeParse(nameless).success).toBe(false);
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
