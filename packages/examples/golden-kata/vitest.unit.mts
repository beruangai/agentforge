import { defineConfig } from 'vitest/config';

/** Unit tier: the base layer's own code, against nothing external. */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/packages/examples/golden-kata',
  test: {
    name: '@beruangai/golden-kata',
    watch: false,
    environment: 'node',
    include: ['base/**/*.test.ts'],
    passWithNoTests: false,
    reporters: ['default'],
  },
});
