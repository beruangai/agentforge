import {
  type ContextBlockFunction,
  composeContext,
} from '@beruangai/agentforge/agent';
import { kataContext } from '@beruangai/golden-kata-base/context';
import type { Difficulty } from '@beruangai/golden-kata-base/kata';

/** How to write a kata, from this layer's `.claude/`. */
const writeInstructions: ContextBlockFunction = () => [
  { tag: 'instructions', filepath: '.claude/fragments/write-kata.md' },
];

/** What this run is asked to write. */
const kataRequest: ContextBlockFunction<{
  topic: string;
  difficulty: Difficulty;
}> = ({ topic, difficulty }) => [{ tag: 'topic', difficulty, context: topic }];

/** The `Write` prompt: static instructions and protocol first, then the run's own. */
export const writeContext = composeContext(
  writeInstructions,
  kataContext,
  kataRequest,
);
