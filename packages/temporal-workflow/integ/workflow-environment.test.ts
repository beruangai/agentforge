// @vitest-environment node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestWorkflowEnvironment } from '@temporalio/testing';

/**
 * TestWorkflowEnvironment integration test.
 *
 * Starts an ephemeral Temporal dev server (no Docker), registers a simple
 * workflow with mocked activities, and verifies end-to-end execution.
 *
 * Requires: @temporalio/testing, @temporalio/worker, @temporalio/workflow
 * Uses `@vitest-environment node` because Temporal Worker needs real filesystem
 * access (jsdom virtualizes it, breaking workflowsPath resolution).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workflowsPath = path.resolve(__dirname, '__fixtures__/test-workflow.ts');

describe('TestWorkflowEnvironment with mocked activities', () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createLocal();
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
  });

  it('executes workflow with mocked activities and returns result', async () => {
    const { Worker: WorkerClass } = await import('@temporalio/worker');
    const expectedResult = { summary: 'Test analysis complete', score: 42 };
    const taskQueue = `test-${Date.now()}`;

    const activities = {
      analyzeData: async (_input: { dataPath: string }) => expectedResult,
    };

    const worker = await WorkerClass.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });

    // runUntil runs the worker until the workflow completes, then stops it
    const result = await worker.runUntil(
      env.client.workflow.execute('testAnalysisWorkflow', {
        workflowId: `test-wf-${randomUUID()}`,
        taskQueue,
        args: [{ dataPath: '/data/test' }],
      }),
    );

    expect(result).toEqual(expectedResult);
  }, 30_000);

  it('workflow propagates activity failure correctly', async () => {
    const { Worker: WorkerClass } = await import('@temporalio/worker');
    const failTaskQueue = `test-fail-${Date.now()}`;

    const failingActivities = {
      analyzeData: async () => {
        throw new Error('Agent task failed: container timeout');
      },
    };

    const worker = await WorkerClass.create({
      connection: env.nativeConnection,
      taskQueue: failTaskQueue,
      workflowsPath,
      activities: failingActivities,
    });

    await expect(
      worker.runUntil(
        env.client.workflow.execute('testAnalysisWorkflow', {
          workflowId: `test-wf-fail-${randomUUID()}`,
          taskQueue: failTaskQueue,
          args: [{ dataPath: '/data/test' }],
        }),
      ),
    ).rejects.toThrow();
  }, 30_000);
});
