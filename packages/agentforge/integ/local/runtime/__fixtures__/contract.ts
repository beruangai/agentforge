import { oc } from '@orpc/contract';
import { z } from 'zod';

/** Procedures that exercise the runtime without a model. */
export const runtimeContract = {
  echo: oc
    .input(z.object({ text: z.string() }))
    .output(z.object({ text: z.string(), attempt: z.number() })),
  /** Runs until cancelled, or for `milliseconds`. */
  wait: oc
    .input(z.object({ milliseconds: z.number() }))
    .output(z.object({ waited: z.boolean() })),
  /** Ignores cancellation and starts a grandchild that writes its pid to `pidFile`. */
  stubborn: oc.input(z.object({ pidFile: z.string() })).output(z.object({})),
  /** Fails on its first attempt, succeeds on the next. */
  flaky: oc
    .input(z.object({}))
    .output(z.object({ attempt: z.number(), priorState: z.string() })),
  crash: oc.input(z.object({})).output(z.object({})),
};
