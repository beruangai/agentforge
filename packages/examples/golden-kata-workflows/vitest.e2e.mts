import { defineConfig } from 'vitest/config';

const CONDITIONS = ['@beruangai/source'];

/**
 * The e2e tier: one suite, a project per place the worker and the agents
 * run, differing only in the environment each target gives it.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir:
    '../../../node_modules/.vite/packages/examples/golden-kata-workflows',
  // The tsconfig's `paths` map golden-kata's base layer to its files, which
  // the host's workspace does not link.
  resolve: { conditions: CONDITIONS, tsconfigPaths: true },
  ssr: { resolve: { conditions: CONDITIONS } },
  test: {
    watch: false,
    environment: 'node',
    fileParallelism: false,
    testTimeout: 600_000,
    projects: [
      {
        extends: true,
        test: { name: 'local', include: ['e2e/local/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'hybrid',
          include: ['e2e/hybrid/**/*.test.ts'],
          globalSetup: ['e2e/hybrid/worker.global-setup.ts'],
        },
      },
      {
        extends: true,
        test: { name: 'agentcore', include: ['e2e/agentcore/**/*.test.ts'] },
      },
    ],
  },
});
