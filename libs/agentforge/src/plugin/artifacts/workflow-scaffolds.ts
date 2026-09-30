import type { WorkflowProject } from '../project-record.ts';
import type { ScaffoldedFile } from './maintained.ts';

/**
 * A workflow project's scaffolds: the bundle's entry, a placeholder workflow
 * calling a placeholder activity, its test against the local server, the
 * project's own activities, its secrets and its test configuration. Written
 * once, the consumer's from then on.
 */
export function workflowProjectScaffolds(
  project: WorkflowProject,
): ScaffoldedFile[] {
  const root = project.root;
  return [
    {
      path: `${root}/workflows/index.ts`,
      content: `/**
 * The workflow bundle's entry: every workflow the worker runs, exported by
 * the name a caller starts it by. Bundled by \`bundle-workflows\`; code here
 * runs in Temporal's sandbox, so it imports agents' contracts as types only,
 * through \`../agents/workflow.ts\`.
 */
export * from './example.ts';
`,
    },
    {
      path: `${root}/workflows/example.ts`,
      content: `import { proxyActivities } from '@temporalio/workflow';
import type { activities } from '../activities/index.ts';

const { greet } = proxyActivities<typeof activities>({
  startToCloseTimeout: '1 minute',
});

/**
 * A placeholder: replace it with the project's workflows, which call the
 * connected agents through \`agents()\` from \`../agents/workflow.ts\`.
 */
export async function example(name: string): Promise<string> {
  return greet(name);
}
`,
    },
    {
      path: `${root}/workflows/example.test.ts`,
      content: `import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { example } from './example.ts';

let environment: TestWorkflowEnvironment;

/** The Temporal CLI's dev server, started for the run from the CLI on PATH. */
beforeAll(async () => {
  environment = await TestWorkflowEnvironment.createLocal({
    server: {
      executable: {
        type: 'existing-path',
        path: execFileSync('which', ['temporal'], { encoding: 'utf8' }).trim(),
      },
    },
  });
});

afterAll(async () => {
  await environment?.teardown();
});

describe('example', () => {
  it('greets through its activity', async () => {
    const taskQueue = randomUUID();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
      activities: { greet: async (name: string) => \`Hello, \${name}\` },
    });
    await expect(
      worker.runUntil(
        environment.client.workflow.execute<typeof example>('example', {
          taskQueue,
          workflowId: randomUUID(),
          args: ['Temporal'],
        }),
      ),
    ).resolves.toBe('Hello, Temporal');
  });
});
`,
    },
    {
      path: `${root}/activities/index.ts`,
      content: `/**
 * The project's own activities, registered by name beside the connected
 * agents' (\`<project>.<agent>.<Procedure>\`); a workflow calls them through
 * \`proxyActivities<typeof activities>\`. A placeholder: replace it.
 */
export const activities = {
  async greet(name: string): Promise<string> {
    return \`Hello, \${name}\`;
  },
};
`,
    },
    {
      path: `${root}/secrets.ts`,
      content: `/**
 * The secrets the worker requires, by the environment variable each becomes —
 * beside AgentForge's own, TEMPORAL_API_KEY. The project's construct requires
 * a secret for each, \`serve\` passes each from .env.serve.local (and
 * .env.hybrid.local), and the worker fails at start while one is unset.
 */
export const REQUIRED_SECRETS = [] as const satisfies readonly string[];
`,
    },
    {
      path: `${root}/vitest.unit.mts`,
      content: `import { defineConfig } from 'vitest/config';

/** Unit tier: the workflows against the Temporal CLI's dev server, their activities stubbed. */
export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: '${project.packageName}',
    watch: false,
    environment: 'node',
    include: ['workflows/**/*.test.ts', 'activities/**/*.test.ts'],
    passWithNoTests: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
`,
    },
  ];
}
