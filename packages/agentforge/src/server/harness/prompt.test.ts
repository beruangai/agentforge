import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  CACHE_MARKER_BLOCK,
  createStreamingInput,
  createUserMessage,
  documentBlock,
  resolveContextBlock,
} from './prompt.ts';

let cwd: string;
beforeAll(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'agentforge-prompt-'));
  await writeFile(path.join(cwd, 'notes.md'), '# Notes');
  await writeFile(path.join(cwd, 'paper.PDF'), '%PDF-1.7');
});

async function contentOf(
  prompt: Parameters<typeof createUserMessage>[0],
): Promise<unknown> {
  return (await createUserMessage(prompt, cwd)).message.content;
}

describe('createUserMessage', () => {
  it('is one user message, sent now, with no parent tool use', async () => {
    expect(await createUserMessage('hello', cwd)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      parent_tool_use_id: null,
      priority: 'now',
    });
  });

  it('keeps content blocks as they are, in order', async () => {
    const document = documentBlock('Title', 'body');
    expect(
      await contentOf(['first', { type: 'text', text: 'second' }, document]),
    ).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
      document,
    ]);
  });

  it('renders a context block as its own tagged text block', async () => {
    expect(
      await contentOf({
        tag: 'tree',
        description: 'the "repo"',
        root: '/src',
        depth: 2,
        skipped: undefined,
        context: 'a/\nb/',
      }),
    ).toEqual([
      {
        type: 'text',
        text: '<tree description="the &quot;repo&quot;" root="/src" depth="2">\na/\nb/\n</tree>',
      },
    ]);
  });

  it('refuses content it cannot place', async () => {
    await expect(contentOf({ type: 'unknown' } as never)).rejects.toThrow(
      /none of/,
    );
  });
});

describe('a command block', () => {
  it('is the command line, then each context entry, then each document', async () => {
    expect(
      await contentOf({
        type: 'command',
        command: 'review',
        args: ['src', 'strict'],
        context: ['plain', { tag: 'focus', context: 'naming' }, ''],
        documents: [{ filepath: 'notes.md', context: 'the brief' }],
      }),
    ).toEqual([
      { type: 'text', text: '/review "src" "strict"' },
      { type: 'text', text: '<context>\nplain\n</context>' },
      { type: 'text', text: '<focus>\nnaming\n</focus>' },
      {
        type: 'document',
        source: { type: 'text', media_type: 'text/plain', data: '# Notes' },
        title: 'notes.md',
        context: '<filepath>notes.md</filepath>\nthe brief',
      },
    ]);
  });

  it('keeps a leading slash, and places cache markers around its blocks', async () => {
    const content = (await contentOf({
      type: 'command',
      command: '/run',
      cache: 'BEFORE_AND_AFTER',
    })) as unknown[];
    expect(content).toEqual([
      CACHE_MARKER_BLOCK,
      { type: 'text', text: '/run' },
      CACHE_MARKER_BLOCK,
    ]);
  });

  it('reads a PDF by its extension, whatever its case', async () => {
    const [, document] = (await contentOf({
      type: 'command',
      command: 'read',
      documents: [{ filepath: 'paper.PDF', title: 'Paper', cache: true }],
    })) as { source: unknown; cache_control: unknown }[];
    expect(document).toMatchObject({
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: Buffer.from('%PDF-1.7').toString('base64'),
      },
      title: 'Paper',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
  });

  it('fails the prompt when a document cannot be read', async () => {
    await expect(
      contentOf({
        type: 'command',
        command: 'read',
        documents: [{ filepath: 'missing.md' }],
      }),
    ).rejects.toThrow(/"missing.md" could not be read/);
  });
});

describe('resolveContextBlock', () => {
  it('defaults the tag, and sets a cache breakpoint when asked', () => {
    expect(
      resolveContextBlock({
        context: 'x',
        cache: { type: 'ephemeral', ttl: '1h' },
      }),
    ).toEqual({
      type: 'text',
      text: '<context>\nx\n</context>',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
  });
});

describe('createStreamingInput', () => {
  it('yields the message, then holds the input open until released', async () => {
    const message = await createUserMessage('hello', cwd);
    const { promise, resolve } = Promise.withResolvers<void>();
    const input = createStreamingInput(message, promise);
    expect(await input.next()).toEqual({ value: message, done: false });
    let ended = false;
    const next = input.next().then((result) => {
      ended = true;
      return result;
    });
    await Promise.resolve();
    expect(ended).toBe(false);
    resolve();
    expect(await next).toEqual({ value: undefined, done: true });
  });
});
