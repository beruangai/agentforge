import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  composeOptions,
  filesystems,
  implementAgent,
  S3Filesystem,
  type S3FilesystemOptions,
} from '@beruangai/agentforge/agent';
import { baseOptions } from '@beruangai/smoke-coverage-base/options';
import { z } from 'zod';
import { helloAgent, TopicField } from './contract.ts';

const os = implementAgent(helloAgent);

/** Where the notebook mounts, so prompts can name it. */
const NOTEBOOK_PATH = '/workspace/notebook';
const NOTE_FILE = join(NOTEBOOK_PATH, 'note.md');

/** The notebook, scoped to the request's topic; a procedure that writes declares its push. */
const NOTEBOOK: S3FilesystemOptions = {
  localPath: NOTEBOOK_PATH,
  bucket: 'notebook',
  // A scope receives its input untyped; the contract's own field reads it.
  scope: ({ input }) => ({
    remotePath: `topics/${z.object({ topic: TopicField }).parse(input).topic}`,
  }),
};

export const router = os.router({
  Summarise: os.Summarise.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: [
        'Summarise the text in one sentence.',
        { tag: 'text', context: input.text },
      ],
      output: z.object({
        summary: z.string().describe('One sentence summarising the text'),
      }),
      options: composeOptions(baseOptions(), {
        maxTurns: 3,
        tools: [],
        ...(input.resumeSessionId === undefined
          ? {}
          : { resume: input.resumeSessionId }),
      }),
    });
    return {
      summary: run.output.summary,
      words: run.output.summary.split(/\s+/).filter(Boolean).length,
      sessionId: run.sessionId,
    };
  }),
  SleepThenAnswer: os.SleepThenAnswer.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: `Run the shell command \`sleep ${input.seconds}\` with the Bash tool, then answer "done".`,
      output: z.object({ answer: z.string() }),
      options: composeOptions(baseOptions(), {
        maxTurns: 4,
        tools: ['Bash'],
        allowedTools: ['Bash'],
      }),
    });
    return { answer: run.output.answer };
  }),
  KeepNote: os.KeepNote.use(
    filesystems({
      notebook: new S3Filesystem({
        ...NOTEBOOK,
        pushOn: ['TASK_STATE_COMPLETED'],
      }),
    }),
  ).handler(async ({ input, context }) => {
    await context.runAgent({
      prompt: [
        `Write the note below, exactly, to the file \`${NOTE_FILE}\` with the Write tool, then answer that you did.`,
        { tag: 'note', context: input.note },
      ],
      output: z.object({ written: z.boolean() }),
      options: composeOptions(baseOptions(), {
        maxTurns: 4,
        tools: ['Write'],
        permissionMode: 'dontAsk',
        allowedTools: [...context.filesystemPermissions.allow],
      }),
    });
    return {
      kept: (await readFile(NOTE_FILE, 'utf8')).trim() === input.note.trim(),
    };
  }),
  RecallNote: os.RecallNote.use(
    filesystems({ notebook: new S3Filesystem(NOTEBOOK) }),
  ).handler(async ({ context }) => {
    const run = await context.runAgent({
      prompt: `Read the file \`${NOTE_FILE}\` with the Read tool, and answer with its content, exactly.`,
      output: z.object({ note: z.string().describe("The file's content") }),
      options: composeOptions(baseOptions(), {
        maxTurns: 4,
        tools: ['Read'],
        permissionMode: 'dontAsk',
        allowedTools: [...context.filesystemPermissions.allow],
      }),
    });
    return { note: run.output.note };
  }),
});
