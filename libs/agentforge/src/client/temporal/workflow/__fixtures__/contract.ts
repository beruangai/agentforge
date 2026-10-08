import { oc } from '@orpc/contract';
import { z } from 'zod';

export const CONTRACTS = {
  writer: {
    Write: oc
      .input(z.strictObject({ topic: z.string() }))
      .output(z.strictObject({ kata: z.string() })),
  },
  grader: {
    rubric: {
      Grade: oc
        .input(z.strictObject({ kata: z.string() }))
        .output(z.strictObject({ score: z.number() })),
    },
  },
};
