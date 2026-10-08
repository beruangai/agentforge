import {
  type ContextBlockFunction,
  composeContext,
} from '@beruangai/agentforge/agent';
import { kataContext } from '@beruangai/golden-kata-base/context';
import type { Difficulty } from '@beruangai/golden-kata-base/kata';

/** How to grade a kata, from this layer's `.claude/`. */
const gradeInstructions: ContextBlockFunction = () => [
  { tag: 'instructions', filepath: '.claude/fragments/grade-kata.md' },
];

/** The difficulty the kata is graded at. */
const kataDifficulty: ContextBlockFunction<{ difficulty: Difficulty }> = ({
  difficulty,
}) => [{ tag: 'difficulty', context: difficulty }];

/** The `Grade` prompt: static instructions and protocol first, then the run's own. */
export const gradeContext = composeContext(
  gradeInstructions,
  kataContext,
  kataDifficulty,
);
