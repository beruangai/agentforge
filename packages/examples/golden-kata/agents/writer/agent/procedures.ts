import { readFile, writeFile } from 'node:fs/promises';
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
import { contract } from './contract.ts';

const os = implementAgent(contract);

export const router = os.router({
  Write: os.Write.use(filesystems({ kata: new ScratchFilesystem() })).handler(
    async ({ input, context }) => {
      const directory = context.filesystems.kata.localPath;
      const run = await context.runAgent({
        prompt: [
          `Write a ${input.difficulty} coding kata about the topic below, following the kata-style skill.`,
          { tag: 'topic', context: input.topic },
          `In ${directory}, write ${KATA_FILE} (the kata) and ${SOLUTION_FILE} (a correct reference solution). Run run_cases, and fix the kata or the solution until every case passes. Then answer with the kata exactly as ${KATA_FILE} holds it.`,
        ],
        output: KataSchema,
        // The base options, plus what the writer alone may do: write the kata's files.
        options: composeOptions(baseOptions(directory), {
          tools: ['Write', 'Edit'],
          allowedTools: [...context.filesystems.kata.permissions.allow],
          maxTurns: 20,
        }),
      });
      // The kata as answered is the kata: written back, so its results are
      // computed from what the caller receives, never from a draft.
      await writeFile(
        join(directory, KATA_FILE),
        JSON.stringify(run.output, null, 2),
      );
      return {
        kata: {
          ...run.output,
          difficulty: input.difficulty,
          referenceSolution: await readFile(
            join(directory, SOLUTION_FILE),
            'utf8',
          ),
        },
        results: await runCases(directory),
      };
    },
  ),
});
