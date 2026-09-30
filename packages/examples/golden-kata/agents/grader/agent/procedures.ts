import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  composeOptions,
  filesystems,
  implementAgent,
  ScratchFilesystem,
} from '@beruangai/agentforge/agent';
import {
  KATA_FILE,
  KataSchema,
  SOLUTION_FILE,
} from '@beruangai/golden-kata-base/kata';
import { baseOptions } from '@beruangai/golden-kata-base/options';
import { runCases } from '@beruangai/golden-kata-base/run-cases';
import { contract, GradeSchema } from './contract.ts';

const os = implementAgent(contract);

export const router = os.router({
  Grade: os.Grade.use(filesystems({ kata: new ScratchFilesystem() })).handler(
    async ({ input, context }) => {
      const directory = context.filesystems.kata.localPath;
      await writeFile(
        join(directory, KATA_FILE),
        JSON.stringify(KataSchema.parse(input.kata), null, 2),
      );
      await writeFile(
        join(directory, SOLUTION_FILE),
        input.kata.referenceSolution,
      );
      const run = await context.runAgent({
        prompt: `Grade the ${input.kata.difficulty} kata in ${directory} — ${KATA_FILE} and its reference ${SOLUTION_FILE} — against the kata-style skill: score each rubric criterion from 1 to 5 with your reasoning, then sum up. Read both files and run run_cases before you judge; change nothing.`,
        output: GradeSchema,
        // The base options alone: the grader reads and runs, and writes nothing.
        options: composeOptions(baseOptions(directory), { maxTurns: 12 }),
      });
      return { ...run.output, results: await runCases(directory) };
    },
  ),
});
