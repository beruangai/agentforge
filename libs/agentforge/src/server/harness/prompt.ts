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
 * becomes `<tree description="the repo" root="/src">\n…\n</tree>`. Its text
 * is `context`, or the content of the file `filepath` names, read when the
 * run starts. Every key but `tag`, `description`, `context`, `filepath` and
 * `cache` is an attribute.
 */
export type ContextBlock = {
  /** Never an attribute: a `type` makes the object a content block or a command. */
  readonly type?: never;
  /** The tag wrapping the block; `context` when omitted. */
  readonly tag?: string;
  readonly description?: string;
  readonly cache?: CacheBreakpoint;
  readonly [attribute: string]: unknown;
} & (
  | { readonly context: string; readonly filepath?: never }
  | {
      /** Absolute, or relative to the run's `cwd`. A file that cannot be read fails the run. */
      readonly filepath: string;
      readonly context?: never;
    }
);

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

export type PromptContent = string | ContentBlock | ContextBlock | CommandBlock;

/** What the agent is asked: one piece of content, or several in order. */
export type AgentPrompt = PromptContent | readonly PromptContent[];

/** Content that may stand in a prompt or in a command's context. */
export type ContextContent = string | ContentBlock | ContextBlock;

/**
 * A piece of an agent's context: input variables in, prompt content out.
 * One without input takes none: `const rules: ContextBlockFunction = () => […]`.
 */
export type ContextBlockFunction<Input extends object = Record<never, never>> =
  (
    input: Input,
  ) => readonly ContextContent[] | Promise<readonly ContextContent[]>;

/** Every input variable a list of context functions needs, as one object type. */
export type ComposedInput<
  Functions extends readonly ContextBlockFunction<never>[],
> = [Functions[number]] extends [never]
  ? Record<never, never>
  : Flatten<UnionToIntersection<InputOf<Functions[number]>>>;

/**
 * One context function from several: its input is every input variable any of
 * them needs, its output each one's content in the order given. The parts are
 * evaluated concurrently, and a composite composes again.
 */
export function composeContext<
  const Functions extends readonly ContextBlockFunction<never>[],
>(
  ...functions: Functions
): (input: ComposedInput<Functions>) => Promise<readonly ContextContent[]> {
  return async (input) =>
    (
      await Promise.all(
        functions.map((contextFunction) => contextFunction(input as never)),
      )
    ).flat();
}

/** A function's input; none when it declares no parameter. */
type InputOf<Function> = Function extends (input: infer Input) => unknown
  ? unknown extends Input
    ? Record<never, never>
    : Input
  : never;

type UnionToIntersection<Union> = (
  Union extends unknown
    ? (argument: Union) => void
    : never
) extends (argument: infer Intersection) => void
  ? Intersection
  : never;

/** An intersection shown as the one object type it is. */
type Flatten<Type> = { [Key in keyof Type]: Type[Key] };

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

const RESERVED_CONTEXT_KEYS = new Set([
  'tag',
  'description',
  'context',
  'filepath',
  'cache',
]);

export async function resolveContextBlock(
  block: ContextBlock,
  cwd: string,
): Promise<TextBlockParam> {
  const { tag = 'context', description } = block;
  const context = await contextBlockText(block, cwd);
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

/** A context block's text: its own, or its file's. */
async function contextBlockText(
  block: ContextBlock,
  cwd: string,
): Promise<string> {
  const { context, filepath } = block;
  if (typeof context === 'string' && filepath === undefined) return context;
  if (typeof filepath !== 'string' || context !== undefined) {
    throw new Error(
      `a context block takes its text from one of \`context\` or \`filepath\`: ${JSON.stringify(block)}`,
    );
  }
  try {
    return await readFile(path.resolve(cwd, filepath), 'utf8');
  } catch (error) {
    throw new Error(
      `the prompt's context block file "${filepath}" could not be read`,
      { cause: error },
    );
  }
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
