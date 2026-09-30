import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** What callers import to call the writer agent. */
export const writer = {
  Write: oc.meta(timeBudget(300)).input(z.object({})).output(z.object({})),
};
