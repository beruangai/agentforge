import { oc } from '@orpc/contract';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contractHash, timeBudget, timeBudgetOf } from './procedures.ts';

const shape = () =>
  oc
    .input(z.strictObject({ a: z.string() }))
    .output(z.strictObject({ b: z.number() }));

describe('a procedure contract', () => {
  it('declares its time budget as meta, or none', () => {
    const budgeted = oc
      .meta(timeBudget(600))
      .input(z.strictObject({ a: z.string() }))
      .output(z.strictObject({ b: z.number() }));
    expect(timeBudgetOf(budgeted)).toBe(600);
    expect(timeBudgetOf(shape())).toBeUndefined();
    expect(() => oc.meta(timeBudget(0))).toThrow();
  });

  it('hashes its shape, not its meta', () => {
    const budgeted = oc
      .meta(timeBudget(60))
      .input(z.strictObject({ a: z.string() }))
      .output(z.strictObject({ b: z.number() }));
    expect(contractHash(budgeted)).toBe(contractHash(shape()));
    expect(
      contractHash(
        oc
          .input(z.strictObject({ a: z.string() }))
          .output(z.strictObject({ b: z.string() })),
      ),
    ).not.toBe(contractHash(shape()));
  });
});
