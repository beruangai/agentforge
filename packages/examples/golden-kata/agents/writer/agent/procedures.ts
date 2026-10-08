import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
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
import { writeContext } from './context.ts';
import { contract } from './contract.ts';

const os = implementAgent(contract);

export const router = os.router({
  Write: os.Write.use(filesystems({ kata: new ScratchFilesystem() })).handler(
    async ({ input, context }) => {
      const { kata } = context.filesystems;
      const directory = kata.localPath;
      const run = await context.runAgent({
        prompt: await writeContext({ directory, ...input }),
        output: KataSchema,
        // The answer is held back until both files it is checked against exist.
        guardrails: {
          stop: [
            async () => {
              const missing = [KATA_FILE, SOLUTION_FILE].filter(
                (file) => !existsSync(kata.path(file)),
              );
              return missing.length === 0
                ? undefined
                : {
                    reason: `Write ${missing.join(' and ')} in ${directory} before answering.`,
                  };
            },
          ],
        },
        // The base options and the mount, plus what the writer alone may do: write the kata's files.
        options: composeOptions(baseOptions(directory), context.agentOptions, {
          tools: ['Write', 'Edit'],
          maxTurns: 20,
        }),
      });
      // The kata as answered is the kata: written back, so its results are
      // computed from what the caller receives, never from a draft.
      await writeFile(
        kata.writablePath(KATA_FILE),
        JSON.stringify(run.output, null, 2),
      );
      return {
        kata: {
          ...run.output,
          difficulty: input.difficulty,
          referenceSolution: await readFile(kata.path(SOLUTION_FILE), 'utf8'),
        },
        results: await runCases(directory),
      };
    },
  ),
});
