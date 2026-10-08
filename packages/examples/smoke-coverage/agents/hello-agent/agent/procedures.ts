import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  composeOptions,
  distill,
  filesystems,
  implementAgent,
  S3Filesystem,
  type S3FilesystemOptions,
} from '@beruangai/agentforge/agent';
import { baseOptions } from '@beruangai/smoke-coverage-base/options';
import { z } from 'zod';
import { contract, SpaceField, TopicField } from './contract.ts';

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

/** The memories bucket, a space per request under one root; a procedure that saves declares its push. */
const MEMORIES: S3FilesystemOptions = {
  localRoot: '/workspace/memories',
  bucket: 'memories',
  scope: ({ input }) => ({
    subpath: `spaces/${z.object({ space: SpaceField }).parse(input).space}`,
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
    const note = context.filesystems.notebook.path('note.md');
    await context.runAgent({
      prompt: [
        `Write the note below, exactly, to the file \`${note}\` with the Write tool, then answer that you did.`,
        { tag: 'note', context: input.note },
      ],
      output: z.object({ written: z.boolean() }),
      options: composeOptions(baseOptions(), context.agentOptions, {
        maxTurns: 4,
        tools: ['Write'],
        permissionMode: 'dontAsk',
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
      prompt: `Read the file \`${context.filesystems.notebook.path('note.md')}\` with the Read tool, and answer with its content, exactly.`,
      output: z.object({ note: z.string().describe("The file's content") }),
      options: composeOptions(baseOptions(), context.agentOptions, {
        maxTurns: 4,
        tools: ['Read'],
        permissionMode: 'dontAsk',
      }),
    });
    return { note: run.output.note };
  }),
  Remember: os.Remember.use(
    filesystems({
      memory: new S3Filesystem({
        ...MEMORIES,
        pushOn: ['TASK_STATE_COMPLETED'],
      }),
    }),
  ).handler(async ({ input, context }) => {
    const memory = context.filesystems.memory;
    await context.runAgent({
      prompt: [
        'Remember the fact below for all future tasks, then submit `saved: true`.',
        { tag: 'fact', context: input.fact },
      ],
      output: z.object({ saved: z.boolean() }),
      memoryDirectory: memory.localPath,
      options: composeOptions(baseOptions(), context.agentOptions, {
        maxTurns: 8,
        tools: ['Read', 'Write', 'Edit'],
        permissionMode: 'dontAsk',
      }),
    });
    const index = memory.path('MEMORY.md');
    return {
      saved:
        existsSync(index) && /\]\(.+\.md\)/.test(await readFile(index, 'utf8')),
    };
  }),
  Recall: os.Recall.use(
    filesystems({ memory: new S3Filesystem(MEMORIES) }),
  ).handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: [
        'Answer the question from what you already know. If you do not know, answer "unknown".',
        { tag: 'question', context: input.question },
      ],
      output: z.object({ answer: z.string() }),
      memoryDirectory: context.filesystems.memory.localPath,
      options: composeOptions(baseOptions(), context.agentOptions, {
        maxTurns: 3,
        tools: [],
        permissionMode: 'dontAsk',
      }),
    });
    return { answer: run.output.answer };
  }),
  ReportNautilusTraderVersion: os.ReportNautilusTraderVersion.handler(
    async ({ context }) => {
      const run = await context.runAgent({
        // A script, not `python -c`: the read fence denies inline code in
        // dontAsk mode, since it cannot tell what the code reads.
        prompt:
          'Run `python report_nautilus_trader_version.py` with the Bash tool, and answer with the version it printed, exactly.',
        output: z.object({
          version: z.string().describe('The version the command printed'),
        }),
        // The venv the base layer installs provides both names; the model may pick either.
        options: composeOptions(baseOptions(), {
          maxTurns: 4,
          tools: ['Bash'],
          allowedTools: ['Bash(python *)', 'Bash(python3 *)'],
          permissionMode: 'dontAsk',
        }),
      });
      return { version: run.output.version };
    },
  ),
});
