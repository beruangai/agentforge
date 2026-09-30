import { timeBudget } from '@beruangai/agentforge/contract';
import {
  CaseResultsSchema,
  WrittenKataSchema,
} from '@beruangai/golden-kata-base/kata';
import { oc } from '@orpc/contract';
import { z } from 'zod';

const ScoreSchema = z.object({
  score: z.number().int().min(1).max(5).describe('1 (poor) to 5 (excellent)'),
  reasoning: z.string().min(1),
});

/** The grade the grader agent gives: one score per rubric criterion. */
export const GradeSchema = z.object({
  scores: z.object({
    CLARITY: ScoreSchema.describe(
      'Whether a solver can tell what to return in every case from the description alone',
    ),
    CASE_COVERAGE: ScoreSchema.describe(
      'Whether the cases cover the typical input and the edge cases the task has',
    ),
    SOLUTION_CORRECTNESS: ScoreSchema.describe(
      'Whether the reference solution is correct for every input the description allows, not only the cases',
    ),
    DIFFICULTY_FIT: ScoreSchema.describe(
      'Whether the kata fits its stated difficulty',
    ),
  }),
  summary: z
    .string()
    .min(1)
    .describe('The overall judgement, in a sentence or two'),
});

/** The fixed rubric: every grade scores each. */
export const RUBRIC_CRITERIA = GradeSchema.shape.scores.keyof().options;

/** What callers import to call the grader agent. */
export const contract = {
  Grade: oc
    .meta(timeBudget(180))
    .input(z.object({ kata: WrittenKataSchema }))
    .output(
      GradeSchema.extend({
        /** The kata run against its reference solution: computed, never asked of the model (§REQ102). */
        results: CaseResultsSchema,
      }),
    ),
};
