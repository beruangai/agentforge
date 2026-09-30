import { defineConfig } from 'vitest/config';

// In this repository AgentForge resolves from source; a consumer's resolves
// the installed bundle and needs neither.
const CONDITIONS = ['@beruangai/source'];

export default defineConfig(() => ({
  root: import.meta.dirname,
  resolve: { conditions: CONDITIONS },
  ssr: { resolve: { conditions: CONDITIONS } },
  cacheDir: '../../../node_modules/.vite/packages/examples/golden-kata-infra',
  test: {
    passWithNoTests: true,
    name: '@beruangai/golden-kata-infra',
    watch: false,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: {
      reportsDirectory:
        '../../../dist/packages/examples/golden-kata-infra/test-output/vitest/coverage',
      provider: 'v8' as const,
    },
  },
}));
