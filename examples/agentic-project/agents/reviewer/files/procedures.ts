import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeOptions, implementAgent } from '@beruangai/agentforge/agent';
import { houseOptions } from '@example/agentic-project/house-options';
import { placeSourceFile } from '@example/agentic-project/source-file';
import { z } from 'zod';
import { FindingSchema, reviewer } from './contract.ts';

const os = implementAgent(reviewer);

export const router = os.router({
  Review: os.Review.handler(async ({ input, context }) => {
    // Before the run: the file goes into a working directory of the task's
    // own, so concurrent tasks in one container never share a file.
    const workingDirectory = join(tmpdir(), context.taskId);
    const path = await placeSourceFile(workingDirectory, input);
    const run = await context.runAgent({
      prompt: [
        `Review ${path} against the house style. Report every violation, one finding per rule broken on a line; report none if the file is clean. Do not change the file.`,
      ],
      output: z.object({ findings: z.array(FindingSchema) }),
      options: composeOptions(houseOptions(workingDirectory), {
        maxTurns: 10,
      }),
    });
    return {
      clean: run.output.findings.length === 0,
      findings: run.output.findings,
    };
  }),
});
