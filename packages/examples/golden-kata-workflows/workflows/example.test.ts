import { execFileSync } from 'node:child_process';
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
      activities: { greet: async (name: string) => `Hello, ${name}` },
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
