import { oc } from '@orpc/contract';
import { z } from 'zod';

/** One agent with one procedure, which the scripted client answers. */
export const CONTRACTS = {
  agent: {
    Run: oc.input(z.object({ text: z.string() })).output(z.string()),
  },
};
