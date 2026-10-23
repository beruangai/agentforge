import { readFile } from 'node:fs/promises';
import {
  filesystems,
  S3Filesystem,
  type S3FilesystemOptions,
} from '@beruangai/agentforge/agent';
import {
  composeOptions,
  implementAgent,
} from '@beruangai/agentforge/strands/agent';
import { baseOptions } from '@beruangai/strands-smoke-base/options';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { makeShell } from '@strands-agents/sdk/vended-tools/shell';
import { z } from 'zod';
import { contract, TopicField } from './contract.ts';

const os = implementAgent(contract);

/** The notebook, a directory per topic under one root; a procedure that writes declares its push. */
const NOTEBOOK: S3FilesystemOptions = {
  localRoot: '/workspace/notebook',
  bucket: 'notebook',
  // A scope receives its input untyped; the contract's own field reads it.
  scope: ({ input }) => ({
    subpath: `topics/${z.object({ topic: TopicField }).parse(input).topic}`,
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
      options: composeOptions(baseOptions(), { limits: { turns: 3 } }),
      ...(input.resumeSessionId === undefined
        ? {}
        : { resume: input.resumeSessionId }),
    });
    return {
      summary: run.output.summary,
      words: run.output.summary.split(/\s+/).filter(Boolean).length,
      sessionId: run.sessionId,
    };
  }),
  SleepThenAnswer: os.SleepThenAnswer.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: `Run the shell command \`sleep ${input.seconds}\` with the shell tool, with a timeout of ${input.seconds + 60} seconds, then answer "done".`,
      output: z.object({ answer: z.string() }),
      options: composeOptions(baseOptions(), {
        tools: [makeShell()],
        limits: { turns: 4 },
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
    const note = context.filesystems.notebook.path('note.md');
    await context.runAgent({
      prompt: [
        `Create the file \`${note}\` with the note below as its content, exactly, using the file tool, then answer that you did.`,
        { tag: 'note', context: input.note },
      ],
      output: z.object({ written: z.boolean() }),
      options: composeOptions(baseOptions(), context.agentOptions, {
        tools: [fileEditor],
        limits: { turns: 4 },
      }),
    });
    return {
      kept: (await readFile(note, 'utf8')).trim() === input.note.trim(),
    };
  }),
  RecallNote: os.RecallNote.use(
    filesystems({ notebook: new S3Filesystem(NOTEBOOK) }),
  ).handler(async ({ context }) => {
    const run = await context.runAgent({
      prompt: `View the file \`${context.filesystems.notebook.path('note.md')}\` with the file tool, and answer with its content, exactly.`,
      output: z.object({ note: z.string().describe("The file's content") }),
      options: composeOptions(baseOptions(), context.agentOptions, {
        tools: [fileEditor],
        limits: { turns: 4 },
      }),
    });
    return { note: run.output.note };
  }),
});
