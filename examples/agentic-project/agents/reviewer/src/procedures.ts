import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeOptions, implementAgent } from '@beruangai/agentforge/agent';
import { z } from 'zod';
import { houseOptions, WORKSPACE } from '#agentic/house-options.ts';
import { FindingSchema, reviewer } from './contract.ts';

const os = implementAgent(reviewer);

export const router = os.router({
  Review: os.Review.handler(async ({ input, context }) => {
    // Before the run: the file goes into a directory of the task's own, so
    // concurrent tasks in one container never share a file.
    const directory = join(WORKSPACE, context.taskId);
    const path = join(directory, input.filename);
    await mkdir(directory, { recursive: true });
    await writeFile(path, input.content);
    const run = await context.runAgent({
      prompt: [
        `Review ${path} against the house style. Report every violation, one finding per rule broken on a line; report none if the file is clean. Do not change the file.`,
      ],
      output: z.object({ findings: z.array(FindingSchema) }),
      options: composeOptions(houseOptions, { maxTurns: 10 }),
    });
    return {
      clean: run.output.findings.length === 0,
      findings: run.output.findings,
    };
  }),
});
