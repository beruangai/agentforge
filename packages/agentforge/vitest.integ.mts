import { configDefaults, defineConfig } from 'vitest/config';
import unit from './vitest.config.mts';

/**
 * Integration tier: real platforms and dependencies — AgentCore, Docker, S3,
 * the Claude CLI — with no model call. Long timeouts, because they shell out
 * to containers and the platform. Never passes empty.
 *
 * Two projects. AgentCore's files run in parallel: each provisions and deletes
 * its own uniquely named runtime, repository and table, so no file can see
 * another's, and a runtime's deletion alone takes about five minutes. The rest
 * run one file at a time. Vitest runs the parallel files first and the
 * sequential ones after (vitest 4.1.11, checked 2026-09-23).
 *
 * Spread rather than `mergeConfig`, which concatenates arrays and would run the
 * unit tests here too. The projects set `include` whole rather than extending
 * the root for the same reason.
 */
const integration = {
  environment: 'node',
  sequence: { concurrent: false },
  testTimeout: 120_000,
  hookTimeout: 120_000,
} as const;

const agentCoreFiles = 'integ/agentcore/**/*.{test,spec}.ts';

export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    name: '@beruangai/agentforge:integ',
    include: [],
    passWithNoTests: false,
    projects: [
      {
        root: unit.root,
        test: {
          ...integration,
          name: '@beruangai/agentforge:integ',
          include: ['integ/**/*.{test,spec}.ts'],
          exclude: [...configDefaults.exclude, agentCoreFiles],
          fileParallelism: false,
        },
      },
      {
        root: unit.root,
        test: {
          ...integration,
          name: '@beruangai/agentforge:integ:agentcore',
          include: [agentCoreFiles],
          fileParallelism: true,
        },
      },
    ],
  },
});
