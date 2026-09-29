import { defineConfig } from 'vitest/config';

/** Unit tier: colocated with their source, against nothing external. */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/libs/agentforge',
  test: {
    name: '@beruangai/agentforge',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    passWithNoTests: false,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../dist/libs/agentforge/test/coverage',
      provider: 'v8' as const,
    },
  },
});
