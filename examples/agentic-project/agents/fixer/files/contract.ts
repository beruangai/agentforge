import { timeBudget } from '@beruangai/agentforge/contract';
import { HOUSE_RULE_IDS } from '@example/agentic-project/house-rules';
import { SourceFileSchema } from '@example/agentic-project/source-file';
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** What callers import to bring a file into the house style. */
export const fixer = {
  Fix: oc
    .meta(timeBudget(300))
    .input(SourceFileSchema)
    .output(
      z.object({
        content: z.string().describe('The file as the agent left it'),
        rulesApplied: z.array(z.enum(HOUSE_RULE_IDS)),
      }),
    ),
};
