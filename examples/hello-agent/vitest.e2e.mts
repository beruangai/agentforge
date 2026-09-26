import { defineConfig } from 'vitest/config';

/**
 * The whole path: this test is a caller, through AgentForge's client, to the
 * agent's own image, the harness, the SDK and a real model. One project per
 * place the image runs, each selected by its own target:
 *
 * - `local`: in Docker, with the subscription token (`e2e`)
 * - `agentcore`: deployed on AgentCore, with the test role (`e2e-agentcore`)
 */
const e2e = {
  fileParallelism: false,
  testTimeout: 300_000,
  hookTimeout: 180_000,
} as const;

export default defineConfig({
  root: import.meta.dirname,
  resolve: { conditions: ['@beruangai/source'] },
  ssr: { resolve: { conditions: ['@beruangai/source'] } },
  test: {
    name: '@beruangai/example-hello-agent:e2e',
    include: [],
    passWithNoTests: false,
    projects: [
      {
        extends: true,
        test: {
          ...e2e,
          name: '@beruangai/example-hello-agent:e2e:local',
          include: ['e2e/local/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          ...e2e,
          name: '@beruangai/example-hello-agent:e2e:agentcore',
          include: ['e2e/agentcore/**/*.test.ts'],
        },
      },
    ],
  },
});
