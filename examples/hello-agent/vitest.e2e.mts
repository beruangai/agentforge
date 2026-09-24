import { defineConfig } from 'vitest/config';

/**
 * The whole path: this test is a caller, through AgentForge's client, to the
 * agent's own image in Docker, the harness, the SDK and a real model.
 */
export default defineConfig({
  root: import.meta.dirname,
  resolve: { conditions: ['@beruangai/source'] },
  ssr: { resolve: { conditions: ['@beruangai/source'] } },
  test: {
    name: '@beruangai/example-hello-agent:e2e',
    include: ['e2e/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
});
