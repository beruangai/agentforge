import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';
import type {
  Prompt,
  PromptContent as SharedPromptContent,
} from '../../../server/harness/framework.ts';
import {
  type CacheBreakpoint,
  type ContextBlock,
  renderContextBlock,
  type ContextBlockFunction as SharedContextBlockFunction,
  type ContextContent as SharedContextContent,
} from '../../../server/harness/prompt.ts';

/** A block the Messages API takes as it is. */
export type ContentBlock =
  | TextBlockParam
  | ImageBlockParam
  | DocumentBlockParam;

/** A file read into the prompt as a document: a PDF by its extension, otherwise text. */
export interface ContextDocument {
  /** Absolute, or relative to the run's `cwd`. A file that cannot be read fails the run. */
  readonly filepath: string;
  /** The file path when omitted. */
  readonly title?: string;
  readonly context?: string;
  readonly cache?: CacheBreakpoint;
}

/** A slash command, with its arguments and what it should read. */
export interface CommandBlock {
  readonly type: 'command';
  /** The command; the leading `/` is added when missing. */
  readonly command: string;
  /** Each is quoted into the command line, as its `$ARGUMENTS`; one containing `"` is refused. */
  readonly args?: readonly string[];
  /** Each entry follows the command in order: a string as a `context` block, the rest as at the top of a prompt. */
  readonly context?: ContextContent | readonly ContextContent[];
  readonly documents?: readonly ContextDocument[];
  /** Where cache breakpoints go around the command's blocks. */
  readonly cache?: 'BEFORE' | 'AFTER' | 'BEFORE_AND_AFTER';
}

/** One piece of a `claude` prompt: shared content, a content block or a command. */
export type PromptContent = SharedPromptContent<ContentBlock | CommandBlock>;

/** What the agent is asked: one piece of content, or several in order. */
export type AgentPrompt = Prompt<ContentBlock | CommandBlock>;

/** Content that may stand in a prompt or in a command's context. */
export type ContextContent = SharedContextContent | ContentBlock;

/**
 * A piece of an agent's context: input variables in, prompt content out.
 * One without input takes none: `const rules: ContextBlockFunction = () => […]`.
 */
export type ContextBlockFunction<Input extends object = Record<never, never>> =
  SharedContextBlockFunction<Input, ContentBlock>;

/** An inline text document. */
export function documentBlock(
  title: string,
  content: string,
  context?: string,
): DocumentBlockParam {
  return {
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: content },
    title,
    ...(context === undefined ? {} : { context }),
  };
}

/** The prompt as the one user message the run starts from. */
export async function createUserMessage(
  prompt: AgentPrompt,
  cwd: string,
): Promise<SDKUserMessage> {
  const contents: readonly PromptContent[] = isArray(prompt)
    ? prompt
    : [prompt];
  const blocks = await Promise.all(
    contents.map((content) => resolveContent(content, cwd)),
  );
  return {
    type: 'user',
    message: { role: 'user', content: blocks.flat() },
    parent_tool_use_id: null,
    priority: 'now',
  };
}

/**
 * Streaming input — what `interrupt()` and hooks need — holding the input
 * open until `holdOpenUntil` settles, so the session is not ended under a
 * run still in progress.
 */
export async function* createStreamingInput(
  message: SDKUserMessage,
  holdOpenUntil: Promise<void>,
): AsyncGenerator<SDKUserMessage> {
  yield message;
  await holdOpenUntil;
}

const CONTENT_BLOCK_TYPES = new Set(['text', 'image', 'document']);

async function resolveContent(
  content: PromptContent,
  cwd: string,
): Promise<ContentBlock[]> {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (content.type === 'command') {
    return resolveCommandBlock(content as CommandBlock, cwd);
  }
  if (
    typeof content.type === 'string' &&
    CONTENT_BLOCK_TYPES.has(content.type)
  ) {
    return [content as ContentBlock];
  }
  if (content.type === undefined) {
    return [await resolveContextBlock(content as ContextBlock, cwd)];
  }
  throw new Error(
    `prompt content is none of a string, a content block, a context block or a command: ${JSON.stringify(content)}`,
  );
}

export async function resolveContextDocument(
  document: ContextDocument,
  cwd: string,
): Promise<DocumentBlockParam> {
  const { filepath } = document;
  let buffer: Buffer;
  try {
    buffer = await readFile(path.resolve(cwd, filepath));
  } catch (error) {
    throw new Error(`the prompt's document "${filepath}" could not be read`, {
      cause: error,
    });
  }
  const source: DocumentBlockParam['source'] =
    path.extname(filepath).toLowerCase() === '.pdf'
      ? {
          type: 'base64',
          media_type: 'application/pdf',
          data: buffer.toString('base64'),
        }
      : {
          type: 'text',
          media_type: 'text/plain',
          data: buffer.toString('utf8'),
        };
  const context = [`<filepath>${filepath}</filepath>`];
  if (document.context) context.push(document.context);
  return {
    type: 'document',
    source,
    title: document.title ?? filepath,
    context: context.join('\n'),
    ...cacheControl(document.cache),
  };
}

export async function resolveContextBlock(
  block: ContextBlock,
  cwd: string,
): Promise<TextBlockParam> {
  return {
    type: 'text',
    text: await renderContextBlock(block, cwd),
    ...cacheControl(block.cache),
  };
}

/** A text block carrying only a cache breakpoint. */
export const CACHE_MARKER_BLOCK: TextBlockParam = {
  type: 'text',
  text: '<!-- cache_marker -->',
  cache_control: { type: 'ephemeral', ttl: '1h' },
};

export async function resolveCommandBlock(
  block: CommandBlock,
  cwd: string,
): Promise<ContentBlock[]> {
  let command = block.command.startsWith('/')
    ? block.command
    : `/${block.command}`;
  if (block.args?.length) {
    for (const argument of block.args) {
      if (argument.includes('"')) {
        throw new Error(
          `command "${command}": an argument containing '"' would split its arguments differently: ${JSON.stringify(argument)}`,
        );
      }
    }
    command += ` ${block.args.map((argument) => `"${argument}"`).join(' ')}`;
  }
  const context =
    block.context === undefined
      ? []
      : isArray(block.context)
        ? block.context
        : [block.context];
  const blocks: ContentBlock[] = [
    { type: 'text', text: command },
    ...(
      await Promise.all(
        context
          .filter((entry) => entry !== '')
          .map((entry) =>
            typeof entry === 'string'
              ? [
                  {
                    type: 'text',
                    text: `<context>\n${entry}\n</context>`,
                  } as const,
                ]
              : resolveContent(entry, cwd),
          ),
      )
    ).flat(),
    ...(await Promise.all(
      (block.documents ?? []).map((document) =>
        resolveContextDocument(document, cwd),
      ),
    )),
  ];
  if (block.cache === 'BEFORE' || block.cache === 'BEFORE_AND_AFTER') {
    blocks.unshift(CACHE_MARKER_BLOCK);
  }
  if (block.cache === 'AFTER' || block.cache === 'BEFORE_AND_AFTER') {
    blocks.push(CACHE_MARKER_BLOCK);
  }
  return blocks;
}

/** A shared cache breakpoint as the Messages API's `cache_control`. */
export function cacheControl(
  cache: CacheBreakpoint | undefined,
): Pick<TextBlockParam, 'cache_control'> {
  if (!cache) return {};
  return {
    cache_control: {
      type: 'ephemeral',
      ttl: cache === true ? '1h' : cache.ttl,
    },
  };
}

/** `Array.isArray` narrowed for readonly arrays, which it does not narrow. */
function isArray<Item>(
  value: Item | readonly Item[],
): value is readonly Item[] {
  return Array.isArray(value);
}
