import { oc } from '@orpc/contract';
import { z } from 'zod';
import { timeBudget } from '../../../../src/core/contract/procedures.ts';

/** Procedures that exercise the runtime without a model. */
export const runtimeContract = {
  echo: oc
    .input(z.strictObject({ text: z.string() }))
    .output(z.strictObject({ text: z.string(), attempt: z.number() })),
  /** Runs until cancelled, or for `milliseconds`. */
  wait: oc
    .input(z.strictObject({ milliseconds: z.number() }))
    .output(z.strictObject({ waited: z.boolean() })),
  /** `wait`, declaring a one-second time budget. */
  hurried: oc
    .meta(timeBudget(1))
    .input(z.strictObject({ milliseconds: z.number() }))
    .output(z.strictObject({ waited: z.boolean() })),
  /** Ignores cancellation and starts a grandchild that writes its pid to `pidFile`. */
  stubborn: oc
    .input(z.strictObject({ pidFile: z.string() }))
    .output(z.strictObject({})),
  /** Fails on its first attempt, succeeds on the next. */
  flaky: oc
    .input(z.strictObject({}))
    .output(z.strictObject({ attempt: z.number(), priorState: z.string() })),
  crash: oc.input(z.strictObject({})).output(z.strictObject({})),
};
