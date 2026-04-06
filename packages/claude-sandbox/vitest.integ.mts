import { defineConfig } from 'vitest/config';

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/packages/claude-sandbox',
  test: {
    name: '@beruangai/agentforge-claude-sandbox:integ',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['integ/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    testTimeout: 120_000,
    passWithNoTests: true,
  },
}));
