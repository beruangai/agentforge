import { defineConfig } from 'vitest/config';

const CONDITIONS = ['@beruangai/source'];

/**
 * The e2e tier: a project per place the agent runs. Both drive hello-agent
 * through the project client; each adds what only that place can show.
 */
export default defineConfig({
  root: import.meta.dirname,
  cacheDir: '../../../node_modules/.vite/packages/examples/smoke-coverage',
  // The tsconfig's `paths` map the base layer's package name to its files,
  // which the host's workspace does not link.
  resolve: { conditions: CONDITIONS, tsconfigPaths: true },
  ssr: { resolve: { conditions: CONDITIONS } },
  test: {
    watch: false,
    environment: 'node',
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 180_000,
    projects: [
      {
        extends: true,
        test: { name: 'local', include: ['e2e/local/**/*.test.ts'] },
      },
      {
        extends: true,
        test: { name: 'agentcore', include: ['e2e/agentcore/**/*.test.ts'] },
      },
    ],
  },
});
