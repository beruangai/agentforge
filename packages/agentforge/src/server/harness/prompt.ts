import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  CacheControlEphemeral,
  DocumentBlockParam,
  ImageBlockParam,
  TextBlockParam,
} from '@anthropic-ai/sdk/resources/messages';

/** A block the Messages API takes as it is. */
export type ContentBlock =
  | TextBlockParam
  | ImageBlockParam
  | DocumentBlockParam;

/** `true` sets a default (5 minute) cache breakpoint on the block. */
export type CacheBreakpoint = boolean | CacheControlEphemeral;

/**
 * A fragment of context, rendered as its own tagged text block so distinct
 * fragments never run together:
 * `{ tag: 'tree', description: 'the repo', root: '/src', context: '…' }`
 * becomes `<tree description="the repo" root="/src">\n…\n</tree>`. Every key
 * but `tag`, `description`, `context` and `cache` is an attribute.
 */
export interface ContextBlock {
  /** The tag wrapping the block; `context` when omitted. */
  readonly tag?: string;
  readonly description?: string;
  readonly context: string;
  readonly cache?: CacheBreakpoint;
  readonly [attribute: string]: unknown;
}

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
  /** Each is quoted into the command line, as its `$ARGUMENTS`. */
  readonly args?: readonly string[];
  /** Each entry becomes its own text block after the command. */
  readonly context?: string | ContextBlock | readonly (string | ContextBlock)[];
  readonly documents?: readonly ContextDocument[];
  /** Where cache breakpoints go around the command's blocks. */
  readonly cache?: 'BEFORE' | 'AFTER' | 'BEFORE_AND_AFTER';
}

export type PromptContent = string | ContentBlock | ContextBlock | CommandBlock;

/** What the agent is asked: one piece of content, or several in order. */
export type AgentPrompt = PromptContent | readonly PromptContent[];

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
  if ('context' in content && typeof content.context === 'string') {
    return [resolveContextBlock(content as ContextBlock)];
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

const RESERVED_CONTEXT_KEYS = new Set([
  'tag',
  'description',
  'context',
  'cache',
]);

export function resolveContextBlock(block: ContextBlock): TextBlockParam {
  const { tag = 'context', description, context } = block;
  const attributes: string[] = [];
  if (description) attributes.push(attribute('description', description));
  for (const [key, value] of Object.entries(block)) {
    if (
      RESERVED_CONTEXT_KEYS.has(key) ||
      value === undefined ||
      value === null
    ) {
      continue;
    }
    attributes.push(
      attribute(
        key,
        typeof value === 'object' ? JSON.stringify(value) : String(value),
      ),
    );
  }
  const opening = [tag, ...attributes].join(' ');
  return {
    type: 'text',
    text: `<${opening}>\n${context}\n</${tag}>`,
    ...cacheControl(block.cache),
  };
}

/** A text block carrying only a cache breakpoint. */
export const CACHE_MARKER_BLOCK: TextBlockParam = {
  type: 'text',
  text: '<!-- cache_marker -->',
  cache_control: { type: 'ephemeral', ttl: '5m' },
};

export async function resolveCommandBlock(
  block: CommandBlock,
  cwd: string,
): Promise<ContentBlock[]> {
  let command = block.command.startsWith('/')
    ? block.command
    : `/${block.command}`;
  if (block.args?.length) {
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
    ...context
      .filter((entry) => entry !== '')
      .map(
        (entry): TextBlockParam =>
          typeof entry === 'string'
            ? { type: 'text', text: `<context>\n${entry}\n</context>` }
            : resolveContextBlock(entry),
      ),
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

function cacheControl(
  cache: CacheBreakpoint | undefined,
): Pick<TextBlockParam, 'cache_control'> {
  if (!cache) return {};
  return {
    cache_control: cache === true ? { type: 'ephemeral', ttl: '5m' } : cache,
  };
}

function attribute(key: string, value: string): string {
  return `${key}="${value.replaceAll('"', '&quot;')}"`;
}

/** `Array.isArray` narrowed for readonly arrays, which it does not narrow. */
function isArray<Item>(
  value: Item | readonly Item[],
): value is readonly Item[] {
  return Array.isArray(value);
}
