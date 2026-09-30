import { defineConfig } from 'vitest/config';

const CONDITIONS = ['@beruangai/source'];

/**
 * The e2e tier: one suite, a project per place the agents run, differing
 * only in how the project client is built.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/packages/examples/golden-kata',
  // The tsconfig's `paths` map the base layer's package name to its files,
  // which the host's workspace does not link.
  resolve: { conditions: CONDITIONS, tsconfigPaths: true },
  ssr: { resolve: { conditions: CONDITIONS } },
  test: {
    watch: false,
    environment: 'node',
    fileParallelism: false,
    testTimeout: 240_000,
    projects: [
      {
        extends: true,
        test: { name: 'local', include: ['e2e/local/**/*.test.ts'] },
      },
    ],
  },
});
