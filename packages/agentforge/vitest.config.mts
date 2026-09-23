import { defineConfig } from 'vitest/config';

/** Unit tier: colocated with their source, against nothing external. */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../node_modules/.vite/packages/agentforge',
  test: {
    name: '@beruangai/agentforge',
    watch: false,
    environment: 'node',
    include: ['src/**/*.{test,spec}.ts'],
    passWithNoTests: true,
    reporters: ['default'],
    coverage: {
      reportsDirectory: '../../dist/packages/agentforge/coverage',
      provider: 'v8' as const,
    },
  },
});
