import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';
import { z } from 'zod';
import { HOUSE_RULE_IDS } from '#agentic/house-rules.ts';
import { WorkspaceFileSchema } from '#agentic/workspace-file.ts';

/** What callers import to bring a file into the house style. */
export const fixer = {
  Fix: oc
    .meta(timeBudget(300))
    .input(WorkspaceFileSchema)
    .output(
      z.object({
        content: z.string().describe('The file as the agent left it'),
        rulesApplied: z.array(z.enum(HOUSE_RULE_IDS)),
      }),
    ),
};
