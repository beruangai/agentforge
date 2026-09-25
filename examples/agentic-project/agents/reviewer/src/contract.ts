import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';
import { z } from 'zod';
import { HOUSE_RULE_IDS } from '#agentic/house-rules.ts';
import { WorkspaceFileSchema } from '#agentic/workspace-file.ts';

export const FindingSchema = z.object({
  rule: z.enum(HOUSE_RULE_IDS),
  line: z.number().int().positive(),
  note: z.string().describe('What on the line breaks the rule'),
});

/** What callers import to review a file against the house style. */
export const reviewer = {
  Review: oc
    .meta(timeBudget(300))
    .input(WorkspaceFileSchema)
    .output(
      z.object({
        clean: z.boolean(),
        findings: z.array(FindingSchema),
      }),
    ),
};
