import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeOptions, implementAgent } from '@beruangai/agentforge/agent';
import { houseOptions } from '@example/agentic-project/house-options';
import { HOUSE_RULE_IDS } from '@example/agentic-project/house-rules';
import { placeSourceFile } from '@example/agentic-project/source-file';
import { z } from 'zod';
import { fixer } from './contract.ts';

const os = implementAgent(fixer);

export const router = os.router({
  Fix: os.Fix.handler(async ({ input, context }) => {
    const workingDirectory = join(tmpdir(), context.taskId);
    const path = await placeSourceFile(workingDirectory, input);
    const run = await context.runAgent({
      prompt: `Bring ${path} into the house style by editing it in place. Then report the ids of the rules you applied.`,
      output: z.object({ rulesApplied: z.array(z.enum(HOUSE_RULE_IDS)) }),
      // The house options, plus what this agent alone may do: edit.
      options: composeOptions(houseOptions(workingDirectory), {
        tools: ['Edit'],
        allowedTools: ['Edit'],
        maxTurns: 15,
      }),
    });
    // After the run: the file itself is the result, read back from the
    // working directory.
    return {
      content: await readFile(path, 'utf8'),
      rulesApplied: run.output.rulesApplied,
    };
  }),
});
