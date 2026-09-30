import { timeBudget } from '@beruangai/agentforge/contract';
import {
  CaseResultsSchema,
  DifficultyEnum,
  WrittenKataSchema,
} from '@beruangai/golden-kata-base/kata';
import { oc } from '@orpc/contract';
import { z } from 'zod';

/** What callers import to call the writer agent. */
export const writer = {
  Write: oc
    .meta(timeBudget(180))
    .input(
      z.object({
        topic: z.string().min(1).describe('What the kata is about'),
        difficulty: DifficultyEnum,
      }),
    )
    .output(
      z.object({
        kata: WrittenKataSchema,
        /** The kata run against its reference solution: computed, never asked of the model (§REQ102). */
        results: CaseResultsSchema,
      }),
    ),
};
