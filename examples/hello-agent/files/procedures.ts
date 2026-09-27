import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  filesystems,
  implementAgent,
  S3Filesystem,
  type S3FilesystemOptions,
} from '@beruangai/agentforge/agent';
import { z } from 'zod';
import { helloAgent } from './contract.ts';

const os = implementAgent(helloAgent);

/** Where the notebook mounts, so prompts can name it. */
const NOTEBOOK_PATH = '/workspace/notebook';
const NOTE_FILE = join(NOTEBOOK_PATH, 'note.md');

/** The notebook, scoped to the request's topic; a procedure that writes declares its push. */
const NOTEBOOK: S3FilesystemOptions = {
  localPath: NOTEBOOK_PATH,
  bucket: 'notebook',
  // The contract has validated the input.
  scope: ({ input }) => ({
    remotePath: `topics/${(input as { readonly topic: string }).topic}`,
  }),
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
  keepNote: os.keepNote
    .use(
      filesystems({
        notebook: new S3Filesystem({
          ...NOTEBOOK,
          push: 'FULFILLED',
        }),
      }),
    )
    .handler(async ({ input, context }) => {
      await context.runAgent({
        prompt: [
          `Write the note below, exactly, to the file \`${NOTE_FILE}\` with the Write tool, then answer that you did.`,
          { tag: 'note', context: input.note },
        ],
        output: z.object({ written: z.boolean() }),
        options: {
          model: 'claude-haiku-4-5',
          maxTurns: 4,
          tools: ['Write'],
          permissionMode: 'dontAsk',
          allowedTools: [...context.filesystemPermissions.allow],
        },
      });
      return {
        kept: (await readFile(NOTE_FILE, 'utf8')).trim() === input.note.trim(),
      };
    }),
  recallNote: os.recallNote
    .use(
      filesystems({
        notebook: new S3Filesystem(NOTEBOOK),
      }),
    )
    .handler(async ({ context }) => {
      const run = await context.runAgent({
        prompt: `Read the file \`${NOTE_FILE}\` with the Read tool, and answer with its content, exactly.`,
        output: z.object({ note: z.string().describe("The file's content") }),
        options: {
          model: 'claude-haiku-4-5',
          maxTurns: 4,
          tools: ['Read'],
          permissionMode: 'dontAsk',
          allowedTools: [...context.filesystemPermissions.allow],
        },
      });
      return { note: run.output.note };
    }),
});
