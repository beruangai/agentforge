import { implementAgent } from '@beruangai/agentforge/agent';
import { z } from 'zod';
import { helloAgent } from './contract.ts';

const os = implementAgent(helloAgent);

/** Where the agent works — the base image's workspace — so a session resumes against the same project. */
const CWD = '/mnt/workspace';

export const router = os.router({
  summarise: os.summarise.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: [
        'Summarise the text in one sentence.',
        { tag: 'text', context: input.text },
      ],
      output: z.object({
        summary: z.string().describe('One sentence summarising the text'),
      }),
      options: {
        cwd: CWD,
        maxTurns: 3,
        tools: [],
        ...(input.resumeSessionId === undefined
          ? {}
          : { resume: input.resumeSessionId }),
      },
    });
    return {
      summary: run.output.summary,
      words: run.output.summary.split(/\s+/).filter(Boolean).length,
      sessionId: run.sessionId,
    };
  }),
  sleepThenAnswer: os.sleepThenAnswer.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: `Run the shell command \`sleep ${input.seconds}\` with the Bash tool, then answer "done".`,
      output: z.object({ answer: z.string() }),
      options: {
        cwd: CWD,
        maxTurns: 4,
        tools: ['Bash'],
        allowedTools: ['Bash'],
      },
    });
    return { answer: run.output.answer };
  }),
});
