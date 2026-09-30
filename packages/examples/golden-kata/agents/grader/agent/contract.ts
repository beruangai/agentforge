import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** What callers import to call the grader agent. */
export const grader = {
  Grade: oc.meta(timeBudget(300)).input(z.object({})).output(z.object({})),
};
