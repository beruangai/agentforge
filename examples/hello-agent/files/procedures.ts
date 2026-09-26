import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  implementAgent,
  type WorkingDirectorySync,
} from '@beruangai/agentforge/agent';
import { z } from 'zod';
import { helloAgent } from './contract.ts';

const os = implementAgent(helloAgent);

/** How this agent syncs its notebook; each procedure overrides what it must. */
const NOTEBOOK_SYNC: WorkingDirectorySync = {
  pull: true,
  push: 'WHEN_COMPLETED',
  continuous: false,
  deletes: false,
  exclude: [],
};

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
        model: 'claude-haiku-4-5',
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
        model: 'claude-haiku-4-5',
        maxTurns: 4,
        tools: ['Bash'],
        allowedTools: ['Bash'],
      },
    });
    return { answer: run.output.answer };
  }),
  keepNote: os.keepNote.handler(async ({ input, context }) => {
    const notebook = await context.openWorkingDirectory({
      name: 'notebook',
      prefix: `topics/${input.topic}`,
      sync: NOTEBOOK_SYNC,
    });
    const file = join(notebook.path, 'note.md');
    await context.runAgent({
      prompt: [
        `Write the note below, exactly, to the file \`${file}\` with the Write tool, then answer that you did.`,
        { tag: 'note', context: input.note },
      ],
      output: z.object({ written: z.boolean() }),
      options: {
        model: 'claude-haiku-4-5',
        maxTurns: 4,
        tools: ['Write'],
        allowedTools: ['Write'],
        additionalDirectories: [notebook.path],
      },
    });
    return {
      kept: (await readFile(file, 'utf8')).trim() === input.note.trim(),
    };
  }),
  recallNote: os.recallNote.handler(async ({ input, context }) => {
    const notebook = await context.openWorkingDirectory({
      name: 'notebook',
      prefix: `topics/${input.topic}`,
      sync: { ...NOTEBOOK_SYNC, push: 'NEVER' },
    });
    const run = await context.runAgent({
      prompt: `Read the file \`${join(notebook.path, 'note.md')}\` with the Read tool, and answer with its content, exactly.`,
      output: z.object({ note: z.string().describe("The file's content") }),
      options: {
        model: 'claude-haiku-4-5',
        maxTurns: 4,
        tools: ['Read'],
        allowedTools: ['Read'],
        additionalDirectories: [notebook.path],
      },
    });
    return { note: run.output.note };
  }),
});
