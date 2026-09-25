import { defineConfig } from 'vitest/config';

/**
 * The whole path for both agents: this test is a caller, through AgentForge's
 * client, to each agent's image — built on the project's agentic base — in
 * Docker, and a real model.
 */
export default defineConfig({
  root: import.meta.dirname,
  // The tsconfig's `paths` map the agentic layer's package name to its files.
  resolve: { conditions: ['@beruangai/source'], tsconfigPaths: true },
  ssr: { resolve: { conditions: ['@beruangai/source'] } },
  test: {
    name: '@beruangai/example-agentic-project:e2e',
    include: ['e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
