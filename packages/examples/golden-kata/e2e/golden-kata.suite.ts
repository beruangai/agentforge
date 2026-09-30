/**
 * The whole path for golden-kata, wherever its agents run: this suite is a
 * caller, through the project client, to the writer and the grader and a
 * real model. Each place it runs builds the client its own way (§REQ701).
 * It asserts only what holds whichever way the model chooses: each output
 * parses, the grade scores every rubric criterion, and each `results` is what
 * an independent run of the returned kata gives — never that the cases pass.
 */
import { randomUUIDv7 } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { awaitTask, type TaskView } from '@beruangai/agentforge/client';
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
import { describe, expect, it } from 'vitest';
import {
  GradeSchema,
  RUBRIC_CRITERIA,
} from '../agents/grader/agent/contract.ts';
import type { Client as GoldenKataClient } from '../client.ts';

const RUNTIME_SESSION_ID = `e2e-${randomUUIDv7()}`;
const POLL_OPTIONS = {
  runtimeSessionId: RUNTIME_SESSION_ID,
  pollIntervalMilliseconds: 2_000,
};

/** The kata run again, here, against its reference solution. */
async function independentResults(kata: WrittenKata): Promise<CaseResults> {
  const directory = await mkdtemp(join(tmpdir(), 'golden-kata-e2e-'));
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

function completed<Output>(
  ended: TaskView<Output>,
  logs: () => string,
): Output {
  if (ended.state !== 'TASK_STATE_COMPLETED') {
    throw new Error(
      `expected completion, got ${JSON.stringify(ended)}\n${logs()}`,
    );
  }
  return ended.output as Output;
}

export function goldenKataSuite(
  client: () => GoldenKataClient,
  logs: () => string = () => '',
): void {
  describe('golden-kata', () => {
    let kata: WrittenKata;

    it('writes a kata whose results are its own', async () => {
      const { writer } = client();
      const started = await writer.Write.SendMessage(
        { topic: 'the running total of a list of numbers', difficulty: 'EASY' },
        {
          runtimeSessionId: RUNTIME_SESSION_ID,
          idempotencyKey: randomUUIDv7(),
        },
      );
      const output = completed(
        await awaitTask(writer.Write, started, POLL_OPTIONS),
        logs,
      );
      kata = WrittenKataSchema.parse(output.kata);
      expect(kata.difficulty).toBe('EASY');
      expect(CaseResultsSchema.parse(output.results)).toEqual(
        await independentResults(kata),
      );
    });

    it('grades the kata on every rubric criterion', async () => {
      const { grader } = client();
      const started = await grader.Grade.SendMessage(
        { kata },
        {
          runtimeSessionId: RUNTIME_SESSION_ID,
          idempotencyKey: randomUUIDv7(),
        },
      );
      const output = completed(
        await awaitTask(grader.Grade, started, POLL_OPTIONS),
        logs,
      );
      const grade = GradeSchema.parse(output);
      expect(Object.keys(grade.scores).sort()).toEqual(
        [...RUBRIC_CRITERIA].sort(),
      );
      expect(CaseResultsSchema.parse(output.results)).toEqual(
        await independentResults(kata),
      );
    });
  });
}
