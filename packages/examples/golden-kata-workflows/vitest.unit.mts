import { defineConfig } from 'vitest/config';

/** Unit tier: the workflows against the Temporal CLI's dev server, their activities stubbed. */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: '@beruangai/golden-kata-workflows',
    watch: false,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['node_modules/**'],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
