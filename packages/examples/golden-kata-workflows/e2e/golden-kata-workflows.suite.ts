/**
 * The whole path for golden-kata-workflows, wherever its worker and agents
 * run: this suite starts `writeAndGrade` through the project's client, a
 * worker runs it, and golden-kata's writer and grader answer with a real
 * model. Each place differs only in its environment (§REQ701). It asserts
 * only what holds whichever way the model chooses: each output parses, the
 * grade scores every rubric criterion, and both `results` are what an
 * independent run of the written kata gives — so the grader graded it.
 */
import { randomUUIDv7 } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { GradeSchema, RUBRIC_CRITERIA } from '@beruangai/golden-kata/grader';
import {
  type CaseResults,
  CaseResultsSchema,
  KATA_FILE,
  KataSchema,
  SOLUTION_FILE,
  type WrittenKata,
  WrittenKataSchema,
} from '@beruangai/golden-kata/kata';
import { runCases } from '@beruangai/golden-kata/run-cases';
import type { Client } from '@temporalio/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectClient, TASK_QUEUE } from '../client.ts';
import type { writeAndGrade } from '../workflows/write-and-grade.ts';

const POLLER_TIMEOUT_MILLISECONDS = 180_000;

/**
 * Until a worker polls the task queue — its workflow side, the queue type
 * an unset one means. Nx starts this target once the worker's task has
 * started, not once it polls, so the caller waits. The agents need no such
 * wait: an activity that finds a container not yet serving is retried.
 */
async function untilPolled(client: Client): Promise<void> {
  const deadline = Date.now() + POLLER_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    const { pollers } = await client.workflowService.describeTaskQueue({
      namespace: client.options.namespace,
      taskQueue: { name: TASK_QUEUE },
    });
    if ((pollers?.length ?? 0) > 0) return;
    await sleep(1_000);
  }
  throw new Error(
    `no worker polled ${TASK_QUEUE} within ${POLLER_TIMEOUT_MILLISECONDS} ms`,
  );
}

/** The kata run again, here, against its reference solution. */
async function independentResults(kata: WrittenKata): Promise<CaseResults> {
  const directory = await mkdtemp(join(tmpdir(), 'golden-kata-workflows-e2e-'));
  try {
    await writeFile(
      join(directory, KATA_FILE),
      JSON.stringify(KataSchema.parse(kata)),
    );
    await writeFile(join(directory, SOLUTION_FILE), kata.referenceSolution);
    return await runCases(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function goldenKataWorkflowsSuite(): void {
  let client: Client;

  beforeAll(async () => {
    client = await connectClient();
    await untilPolled(client);
  }, POLLER_TIMEOUT_MILLISECONDS + 10_000);

  afterAll(async () => {
    await client?.connection.close();
  });

  describe('writeAndGrade', () => {
    it('writes a kata and grades the kata it wrote', async () => {
      const handle = await client.workflow.start<typeof writeAndGrade>(
        'writeAndGrade',
        {
          taskQueue: TASK_QUEUE,
          workflowId: `e2e-${randomUUIDv7()}`,
          args: [
            {
              topic: 'the running total of a list of numbers',
              difficulty: 'EASY',
            },
          ],
        },
      );
      const { written, grade } = await handle.result();
      const kata = WrittenKataSchema.parse(written.kata);
      expect(kata.difficulty).toBe('EASY');
      const results = await independentResults(kata);
      expect(CaseResultsSchema.parse(written.results)).toEqual(results);
      const parsedGrade = GradeSchema.parse(grade);
      expect(Object.keys(parsedGrade.scores).sort()).toEqual(
        [...RUBRIC_CRITERIA].sort(),
      );
      // The grader ran the kata the writer wrote.
      expect(CaseResultsSchema.parse(grade.results)).toEqual(results);
    });
  });
}
