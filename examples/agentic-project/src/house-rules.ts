/**
 * The house style: one source for the MCP server that serves each rule and
 * the contracts that cite them by id.
 */
export const HOUSE_RULES = {
  R1: 'Every exported function has a JSDoc comment directly above it.',
  R2: 'No `var`: declare with `const`, or `let` when reassigned.',
  R3: 'No TODO comments; open an issue instead.',
} as const;

export type HouseRuleId = keyof typeof HOUSE_RULES;

export const HOUSE_RULE_IDS = Object.keys(HOUSE_RULES) as [
  HouseRuleId,
  ...HouseRuleId[],
];
