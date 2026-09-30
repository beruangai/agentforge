import { oc } from '@orpc/contract';
import { z } from 'zod';

export const CONTRACTS = {
  writer: {
    Write: oc
      .input(z.object({ topic: z.string() }))
      .output(z.object({ kata: z.string() })),
  },
  grader: {
    rubric: {
      Grade: oc
        .input(z.object({ kata: z.string() }))
        .output(z.object({ score: z.number() })),
    },
  },
};
