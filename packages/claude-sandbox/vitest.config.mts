import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/packages/claude-sandbox',
  test: {
    name: '@beruangai/agentforge-claude-sandbox',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      enabled: true,
      reportsDirectory: './test-output/vitest/coverage',
      provider: 'v8' as const,
    },
    passWithNoTests: true,
  },
}));
