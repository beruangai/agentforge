import { defineConfig } from 'vitest/config';
import unit from './vitest.config.mts';

/**
 * Integration tier: real platforms and dependencies — AgentCore, Docker, S3,
 * the Claude CLI — with no model call. Sequential with long timeouts, because
 * they shell out to containers and the platform. Never passes empty.
 *
 * Spread rather than `mergeConfig`, which concatenates arrays and would run the
 * unit tests here too.
 */
export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    name: '@beruangai/agentforge:integ',
    include: ['integ/**/*.{test,spec}.ts'],
    passWithNoTests: false,
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
