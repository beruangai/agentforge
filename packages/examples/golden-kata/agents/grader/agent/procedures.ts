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
import { gradeContext } from './context.ts';
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
        prompt: await gradeContext({
          directory,
          difficulty: input.kata.difficulty,
        }),
        output: GradeSchema,
        // The base options and the mount: the grader reads and runs, and has no tool to write.
        options: composeOptions(baseOptions(directory), context.agentOptions, {
          maxTurns: 12,
        }),
      });
      return { ...run.output, results: await runCases(directory) };
    },
  ),
});
