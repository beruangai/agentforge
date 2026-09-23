import { defineConfig } from 'vitest/config';
import unit from './vitest.config.mts';

/**
 * End-to-end tier: a real model. Costs money; run after a change that could
 * move structured output, settlement, in-turn correction or usage — not on
 * every commit. Never passes empty.
 *
 * Spread rather than `mergeConfig`, which concatenates arrays and would run the
 * unit tests here too.
 */
export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    name: '@beruangai/agentforge:e2e',
    include: ['e2e/**/*.{test,spec}.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
