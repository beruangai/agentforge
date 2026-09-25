import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeOptions, implementAgent } from '@beruangai/agentforge/agent';
import { z } from 'zod';
import { houseOptions, WORKSPACE } from '#agentic/house-options.ts';
import { HOUSE_RULE_IDS } from '#agentic/house-rules.ts';
import { fixer } from './contract.ts';

const os = implementAgent(fixer);

export const router = os.router({
  Fix: os.Fix.handler(async ({ input, context }) => {
    const directory = join(WORKSPACE, context.taskId);
    const path = join(directory, input.filename);
    await mkdir(directory, { recursive: true });
    await writeFile(path, input.content);
    const run = await context.runAgent({
      prompt: `Bring ${path} into the house style by editing it in place. Then report the ids of the rules you applied.`,
      output: z.object({ rulesApplied: z.array(z.enum(HOUSE_RULE_IDS)) }),
      // The house options, plus what this agent alone may do: edit.
      options: composeOptions(houseOptions, {
        tools: ['Edit'],
        allowedTools: ['Edit'],
        maxTurns: 15,
      }),
    });
    // After the run: the file itself is the result, read back from the workspace.
    return {
      content: await readFile(path, 'utf8'),
      rulesApplied: run.output.rulesApplied,
    };
  }),
});
