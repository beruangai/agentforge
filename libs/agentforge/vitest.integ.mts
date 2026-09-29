import { defineConfig } from 'vitest/config';
import unit from './vitest.config.mts';

/**
 * Integration tier: live slices of what AgentForge relies on and the platform
 * does not guarantee. The gate before publishing, never run on every commit.
 * Never passes empty.
 *
 * Grouped by what a test needs to run, which is also what it costs — one
 * folder under `integ/` each, selected by the `integ` target's configurations:
 *
 * - `local`: Docker and the local toolchain; no credentials, no spend
 * - `aws`: the test role in `us-east-2` (`.env.integ`); AgentCore, and
 *   S3 filesystems' `s7cmd` against a scratch bucket
 * - `model`: the subscription token (`.env.integ.local`); model inference
 *
 * AgentCore's files run in parallel: each provisions and deletes its own
 * uniquely named runtime, so no file can see another's, and a runtime's
 * deletion alone takes about five minutes. Everything else runs one file at a
 * time. Vitest runs the parallel files first and the sequential ones after
 * (vitest 4.1.11, checked 2026-09-23).
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

const testFiles = '**/*.{test,spec}.ts';

export default defineConfig({
  ...unit,
  test: {
    ...unit.test,
    name: '@beruangai/agentforge:integ',
    include: [],
    passWithNoTests: false,
    projects: [
      {
        root: import.meta.dirname,
        test: {
          ...integration,
          name: '@beruangai/agentforge:integ:local',
          include: [`integ/local/${testFiles}`],
          fileParallelism: false,
        },
      },
      {
        root: import.meta.dirname,
        test: {
          ...integration,
          name: '@beruangai/agentforge:integ:aws:agentcore',
          include: [`integ/aws/agentcore/${testFiles}`],
          fileParallelism: true,
        },
      },
      {
        root: import.meta.dirname,
        test: {
          ...integration,
          name: '@beruangai/agentforge:integ:aws:filesystem-s3-sync',
          include: [`integ/aws/filesystem-s3-sync/${testFiles}`],
          fileParallelism: false,
        },
      },
      {
        root: import.meta.dirname,
        test: {
          ...integration,
          name: '@beruangai/agentforge:integ:model',
          include: [`integ/model/${testFiles}`],
          fileParallelism: false,
          testTimeout: 600_000,
        },
      },
    ],
  },
});
