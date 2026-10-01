import { readFile } from 'node:fs/promises';
import {
  composeOptions,
  distill,
  filesystems,
  implementAgent,
  type MountedFilesystem,
  S3Filesystem,
  type S3FilesystemOptions,
} from '@beruangai/agentforge/agent';
import { baseOptions } from '@beruangai/smoke-coverage-base/options';
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

/** The topic's note in the mounted notebook. */
function noteFile(
  filesystems: Readonly<Record<string, MountedFilesystem>>,
): string {
  const notebook = filesystems.notebook;
  if (notebook === undefined) throw new Error('the notebook is not mounted');
  return notebook.path('note.md');
}

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
  DistillThenAnswer: os.DistillThenAnswer.handler(
    async ({ input, context }) => {
      const documents = await distill(context, {
        documents: input.documents,
        instruction: `what answers this question: ${input.question}`,
        capTokens: input.capTokens,
      });
      const run = await context.runAgent({
        prompt: [
          ...documents,
          `Answer the question from the context above only.`,
          { tag: 'question', context: input.question },
        ],
        output: z.object({ answer: z.string() }),
        options: composeOptions(baseOptions(), { maxTurns: 3, tools: [] }),
      });
      return {
        answer: run.output.answer,
        distilled: documents.some((block) => block.tag === 'distillation'),
      };
    },
  ),
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
    const note = noteFile(context.filesystems);
    await context.runAgent({
      prompt: [
        `Write the note below, exactly, to the file \`${note}\` with the Write tool, then answer that you did.`,
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
      kept: (await readFile(note, 'utf8')).trim() === input.note.trim(),
    };
  }),
  RecallNote: os.RecallNote.use(
    filesystems({ notebook: new S3Filesystem(NOTEBOOK) }),
  ).handler(async ({ context }) => {
    const run = await context.runAgent({
      prompt: `Read the file \`${noteFile(context.filesystems)}\` with the Read tool, and answer with its content, exactly.`,
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
