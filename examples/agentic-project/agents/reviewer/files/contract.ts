import { timeBudget } from '@beruangai/agentforge/contract';
import { HouseRuleIdEnum } from '@example/agentic-project/house-rules';
import { SourceFileSchema } from '@example/agentic-project/source-file';
import { oc } from '@orpc/contract';
import { z } from 'zod';

export const FindingSchema = z.object({
  rule: HouseRuleIdEnum,
  line: z.number().int().positive(),
  note: z.string().describe('What on the line breaks the rule'),
});

/** What callers import to review a file against the house style. */
export const reviewer = {
  Review: oc
    .meta(timeBudget(300))
    .input(SourceFileSchema)
    .output(
      z.object({
        clean: z.boolean(),
        findings: z.array(FindingSchema),
      }),
    ),
};
