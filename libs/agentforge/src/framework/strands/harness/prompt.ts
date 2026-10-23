import {
  CachePointBlock,
  type ContentBlock,
  TextBlock,
} from '@strands-agents/sdk';
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

/** One piece of a `strands` prompt: shared content, or one of the SDK's content blocks. */
export type PromptContent = SharedPromptContent<ContentBlock>;

/** What the agent is asked: one piece of content, or several in order. */
export type AgentPrompt = Prompt<ContentBlock>;

/** Content that may stand in a prompt. */
export type ContextContent = SharedContextContent | ContentBlock;

/**
 * A piece of an agent's context: input variables in, prompt content out.
 * One without input takes none: `const rules: ContextBlockFunction = () => […]`.
 */
export type ContextBlockFunction<Input extends object = Record<never, never>> =
  SharedContextBlockFunction<Input, ContentBlock>;

/**
 * The prompt as the SDK's content blocks: a string as a text block, a context
 * block as its tagged text, followed by a cache point when it carries a
 * breakpoint, and the SDK's own blocks as they are. A context block's file is
 * read against `cwd`.
 */
export async function renderPrompt(
  prompt: AgentPrompt,
  cwd: string,
): Promise<ContentBlock[]> {
  const contents: readonly PromptContent[] = isArray(prompt)
    ? prompt
    : [prompt];
  const blocks = await Promise.all(
    contents.map((content) => resolveContent(content, cwd)),
  );
  return blocks.flat();
}

async function resolveContent(
  content: PromptContent,
  cwd: string,
): Promise<ContentBlock[]> {
  if (typeof content === 'string') return [new TextBlock(content)];
  if (content.type === undefined) {
    const block = content as ContextBlock;
    return [
      new TextBlock(await renderContextBlock(block, cwd)),
      ...cachePoint(block.cache),
    ];
  }
  return [content as ContentBlock];
}

/** A shared cache breakpoint as the SDK's cache point, after the block it ends. */
export function cachePoint(
  cache: CacheBreakpoint | undefined,
): CachePointBlock[] {
  if (!cache) return [];
  return [
    new CachePointBlock({
      cacheType: 'default',
      ttl: cache === true ? '1h' : cache.ttl,
    }),
  ];
}

/** `Array.isArray` narrowed for readonly arrays, which it does not narrow. */
function isArray<Item>(
  value: Item | readonly Item[],
): value is readonly Item[] {
  return Array.isArray(value);
}
