import { z } from 'zod';

/** The files a kata is worked on in: the kata itself, and a solution to it. */
export const KATA_FILE = 'kata.json';
export const SOLUTION_FILE = 'solution.ts';

/**
 * One case: arguments and expected result as JSON text, so the agent's
 * structured output stays a closed schema whatever the kata's types.
 */
export const KataCaseSchema = z.object({
  arguments: z
    .string()
    .describe('A JSON array of the arguments the function is called with'),
  expected: z.string().describe('The JSON of the value the function returns'),
});

export const KataSchema = z.object({
  title: z.string().min(1),
  description: z
    .string()
    .min(1)
    .describe('What the function must do, as a solver reads it'),
  functionName: z
    .string()
    .regex(/^[A-Za-z_$][\w$]*$/)
    .describe('The name the solution exports the function under'),
  signature: z
    .string()
    .min(1)
    .describe(
      'The function\'s TypeScript signature, e.g. "(values: number[]) => number"',
    ),
  cases: z.array(KataCaseSchema).min(3).max(10).describe('Three to ten cases'),
});
export type Kata = z.infer<typeof KataSchema>;

/** A kata with the solution its writer checked it against. */
export const WrittenKataSchema = KataSchema.extend({
  referenceSolution: z
    .string()
    .describe(`The writer's ${SOLUTION_FILE}, exporting the function`),
});
export type WrittenKata = z.infer<typeof WrittenKataSchema>;

export const CaseResultSchema = z.object({
  passed: z.boolean(),
  /** Why the case failed, or what it returned. */
  detail: z.string(),
});

/** How a solution fared against a kata's cases: computed, never asked of the model. */
export const CaseResultsSchema = z.object({
  passed: z.number().int(),
  total: z.number().int(),
  cases: z.array(CaseResultSchema),
});
export type CaseResults = z.infer<typeof CaseResultsSchema>;
