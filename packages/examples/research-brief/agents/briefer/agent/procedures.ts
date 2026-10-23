import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  filesystems,
  S3Filesystem,
  type S3FilesystemOptions,
} from '@beruangai/agentforge/agent';
import {
  composeOptions,
  implementAgent,
} from '@beruangai/agentforge/strands/agent';
import { baseOptions } from '@beruangai/research-brief-base/options';
import { AfterToolCallEvent, type Plugin } from '@strands-agents/sdk';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { z } from 'zod';
import { CorpusField, contract } from './contract.ts';

const os = implementAgent(contract);

/** The documents, a directory per corpus under one root; only read. */
const DOCUMENTS: S3FilesystemOptions = {
  localRoot: '/workspace/documents',
  bucket: 'documents',
  scope: ({ input }) => ({
    subpath: `corpora/${z.object({ corpus: CorpusField }).parse(input).corpus}`,
  }),
};

/** Every file the file tool viewed, by absolute path, as the run goes. */
function viewedFiles(): {
  readonly plugin: Plugin;
  readonly viewed: Set<string>;
} {
  const viewed = new Set<string>();
  return {
    viewed,
    plugin: {
      name: 'research-brief:viewed-files',
      initAgent: (agent) => {
        agent.addHook(AfterToolCallEvent, (event) => {
          const input = event.toolUse.input as {
            command?: unknown;
            path?: unknown;
          };
          if (
            event.toolUse.name === fileEditor.name &&
            input.command === 'view' &&
            typeof input.path === 'string' &&
            event.result.status === 'success'
          ) {
            viewed.add(path.resolve(input.path));
          }
        });
      },
    },
  };
}

export const router = os.router({
  Brief: os.Brief.use(
    filesystems({ documents: new S3Filesystem(DOCUMENTS) }),
  ).handler(async ({ input, context }) => {
    const corpus = context.filesystems.documents;
    const names = (
      await readdir(corpus.localPath, { recursive: true, withFileTypes: true })
    )
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path.relative(
          corpus.localPath,
          path.join(entry.parentPath, entry.name),
        ),
      )
      .sort();
    if (names.length === 0) {
      throw new Error(`corpus "${input.corpus}" holds no documents`);
    }
    const texts = new Map(
      await Promise.all(
        names.map(
          async (name) =>
            [name, await readFile(corpus.path(name), 'utf8')] as const,
        ),
      ),
    );
    const [first, ...rest] = names as [string, ...string[]];
    // Every claim cites a document of this corpus, in its own words: a
    // citation that names another document, or a quote the document does
    // not hold, is refused in the agent's turn.
    const brief = z
      .object({
        summary: z
          .string()
          .describe('Two or three sentences answering the question'),
        claims: z
          .array(
            z.object({
              statement: z.string(),
              citations: z
                .array(
                  z.object({
                    document: z.enum([first, ...rest]),
                    quote: z
                      .string()
                      .describe('Words copied exactly from the document'),
                  }),
                )
                .min(1),
            }),
          )
          .min(1),
      })
      .superRefine((answer, refinement) => {
        answer.claims.forEach((claim, claimIndex) => {
          claim.citations.forEach((citation, citationIndex) => {
            if (!texts.get(citation.document)?.includes(citation.quote)) {
              refinement.addIssue({
                code: 'custom',
                path: [
                  'claims',
                  claimIndex,
                  'citations',
                  citationIndex,
                  'quote',
                ],
                message: `"${citation.quote}" is not in ${citation.document}: quote its words exactly`,
              });
            }
          });
        });
      });
    const { plugin, viewed } = viewedFiles();
    const run = await context.runAgent({
      prompt: [
        {
          tag: 'documents',
          context: names.map((name) => corpus.path(name)).join('\n'),
          description: 'The corpus, by absolute path',
        },
        'Read every document above with the file tool. Then answer the question with a brief: a short summary, and claims that each cite the documents they rest on, quoting their exact words.',
        'Your glossary is your memory: search it for terms the question uses before you answer, and add each term a document defines to it with add_memory, as "TERM: definition".',
        { tag: 'question', context: input.question },
      ],
      output: brief,
      memorySpace: input.glossary,
      // The answer is held back until every document has been read.
      guardrails: {
        stop: [
          async () => {
            const unread = names.filter(
              (name) => !viewed.has(corpus.path(name)),
            );
            return unread.length === 0
              ? undefined
              : {
                  reason: `Read ${unread.map((name) => corpus.path(name)).join(', ')} with the file tool before answering.`,
                };
          },
        ],
      },
      options: composeOptions(baseOptions(), context.agentOptions, {
        tools: [fileEditor],
        plugins: [plugin],
        limits: { turns: 16 },
      }),
    });
    return { ...run.output, documents: names.length };
  }),
});
