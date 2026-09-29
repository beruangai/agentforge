import { z } from 'zod';

/**
 * The house style: one source for the MCP server that serves each rule and
 * the contracts that cite them by id.
 */
const HOUSE_RULE_IDS = ['R1', 'R2', 'R3'] as const;

export const HouseRuleIdEnum = z.enum(HOUSE_RULE_IDS);

export type HouseRuleId = z.infer<typeof HouseRuleIdEnum>;

export const HOUSE_RULES: Readonly<Record<HouseRuleId, string>> = {
  R1: 'Every exported function has a JSDoc comment directly above it.',
  R2: 'No `var`: declare with `const`, or `let` when reassigned.',
  R3: 'No TODO comments; open an issue instead.',
};
