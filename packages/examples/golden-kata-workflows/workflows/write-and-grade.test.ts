import { execFileSync } from 'node:child_process';
import { randomUUIDv7 } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ActivityStart } from '@beruangai/agentforge/temporal';
import type {
  Inputs as GoldenKataInputs,
  Outputs as GoldenKataOutputs,
} from '@beruangai/golden-kata/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { writeAndGrade } from './write-and-grade.ts';

type WriteInput = GoldenKataInputs['writer']['Write'];
type Written = GoldenKataOutputs['writer']['Write'];
type Grade = GoldenKataOutputs['grader']['Grade'];

const WRITTEN: Written = {
  kata: {
    title: 'Sum',
    description: 'Return the sum of the values.',
    functionName: 'sum',
    signature: '(values: number[]) => number',
    cases: [
      { arguments: '[[]]', expected: '0' },
      { arguments: '[[1]]', expected: '1' },
      { arguments: '[[1, 2]]', expected: '3' },
    ],
    difficulty: 'EASY',
    referenceSolution:
      'export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);',
  },
  results: { passed: 3, total: 3, cases: [] },
};
const SCORE = { score: 5, reasoning: 'clear' };
const GRADE: Grade = {
  scores: {
    CLARITY: SCORE,
    CASE_COVERAGE: SCORE,
    SOLUTION_CORRECTNESS: SCORE,
    DIFFICULTY_FIT: SCORE,
  },
  summary: 'A fine kata.',
  results: WRITTEN.results,
};

const write = vi.fn(
  async (_input: WriteInput, _start: ActivityStart) => WRITTEN,
);
const grade = vi.fn(
  async (_input: GoldenKataInputs['grader']['Grade'], _start: ActivityStart) =>
    GRADE,
);

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

describe('writeAndGrade', () => {
  it("grades the kata the writer wrote, both in the workflow's runtime session", async () => {
    const taskQueue = randomUUIDv7();
    const workflowId = randomUUIDv7();
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
      // This repository resolves AgentForge from its source.
      bundlerOptions: {
        webpackConfigHook: (config) => ({
          ...config,
          resolve: {
            ...config.resolve,
            conditionNames: ['@beruangai/source', '...'],
          },
        }),
      },
      activities: {
        'goldenKata.writer.Write': write,
        'goldenKata.grader.Grade': grade,
      },
    });
    const input: WriteInput = { topic: 'sums', difficulty: 'EASY' };
    await expect(
      worker.runUntil(
        environment.client.workflow.execute<typeof writeAndGrade>(
          'writeAndGrade',
          { taskQueue, workflowId, args: [input] },
        ),
      ),
    ).resolves.toEqual({ written: WRITTEN, grade: GRADE });
    expect(write).toHaveBeenCalledWith(input, { runtimeSessionId: workflowId });
    expect(grade).toHaveBeenCalledWith(
      { kata: WRITTEN.kata },
      { runtimeSessionId: workflowId },
    );
  });
});
