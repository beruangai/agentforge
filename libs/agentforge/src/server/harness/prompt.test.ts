import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import {
  CACHE_MARKER_BLOCK,
  type ContextBlock,
  type ContextBlockFunction,
  type ContextContent,
  composeContext,
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
  await writeFile(path.join(cwd, 'dates.md'), 'Dates are ISO 8601.');
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

  it('gives a context block no `type`, which would route it as something else', () => {
    expectTypeOf({
      tag: 'note',
      type: 'text' as const,
      context: 'x',
    }).not.toExtend<ContextBlock>();
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

  it('refuses an argument containing a double quote', async () => {
    await expect(
      contentOf({ type: 'command', command: 'review', args: ['a" "b'] }),
    ).rejects.toThrow(/an argument containing '"'/);
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

describe('a context block naming a file', () => {
  const inline = {
    type: 'text',
    text: '<protocol name="dates">\nDates are ISO 8601.\n</protocol>',
    cache_control: { type: 'ephemeral', ttl: '5m' },
  };

  it('renders as the same block with the file inline, relative or absolute', async () => {
    expect(
      await contentOf([
        { tag: 'protocol', name: 'dates', filepath: 'dates.md', cache: true },
        {
          tag: 'protocol',
          name: 'dates',
          filepath: path.join(cwd, 'dates.md'),
          cache: true,
        },
      ]),
    ).toEqual([inline, inline]);
  });

  it('renders the same in a command’s context', async () => {
    expect(
      await contentOf({
        type: 'command',
        command: 'kata',
        context: [
          { tag: 'protocol', name: 'dates', filepath: 'dates.md', cache: true },
        ],
      }),
    ).toEqual([{ type: 'text', text: '/kata' }, inline]);
  });

  it('fails the prompt when its file cannot be read, naming it', async () => {
    await expect(contentOf({ filepath: 'missing.md' })).rejects.toThrow(
      /context block file "missing.md" could not be read/,
    );
    await expect(
      contentOf({
        type: 'command',
        command: 'kata',
        context: { filepath: 'missing.md' },
      }),
    ).rejects.toThrow(/"missing.md" could not be read/);
  });

  it.each([
    ['both keys', { context: 'x', filepath: 'dates.md' }],
    ['neither key', { tag: 'protocol' }],
  ])('refuses a block with %s', async (_, block) => {
    await expect(contentOf(block as never)).rejects.toThrow(
      /one of `context` or `filepath`/,
    );
  });

  it('takes one of the two keys, never both', () => {
    expectTypeOf({ filepath: 'a.md' }).toExtend<ContextBlock>();
    expectTypeOf({
      context: 'x',
      filepath: 'a.md',
    }).not.toExtend<ContextBlock>();
  });
});

describe('a command’s context', () => {
  it('places a content block where it stands', async () => {
    const image = {
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.png' },
    } as const;
    expect(
      await contentOf({
        type: 'command',
        command: 'look',
        context: ['first', image, { tag: 'then', context: 'last' }],
      }),
    ).toEqual([
      { type: 'text', text: '/look' },
      { type: 'text', text: '<context>\nfirst\n</context>' },
      image,
      { type: 'text', text: '<then>\nlast\n</then>' },
    ]);
  });
});

describe('composeContext', () => {
  const protocol: ContextBlockFunction = () => [
    { tag: 'protocol', filepath: 'dates.md' },
  ];
  const directory: ContextBlockFunction<{ directory: string }> = async ({
    directory,
  }) => [{ tag: 'directory', context: directory }];
  const topic: ContextBlockFunction<{ topic: string }> = ({ topic }) => [
    `The topic is ${topic}.`,
  ];

  it('returns each part’s content in the order given, sync or not', async () => {
    const context = composeContext(protocol, directory, topic);
    expect(await context({ directory: '/k', topic: 'dates' })).toEqual([
      { tag: 'protocol', filepath: 'dates.md' },
      { tag: 'directory', context: '/k' },
      'The topic is dates.',
    ]);
  });

  it('nests, a composite composing like any other part', async () => {
    const context = composeContext(
      composeContext(protocol, directory),
      topic,
      () => ['closing'],
    );
    expect(await context({ directory: '/k', topic: 'dates' })).toEqual([
      { tag: 'protocol', filepath: 'dates.md' },
      { tag: 'directory', context: '/k' },
      'The topic is dates.',
      'closing',
    ]);
  });

  it('returns nothing from nothing', async () => {
    expect(await composeContext()({})).toEqual([]);
  });

  it('needs every input variable any part needs, and nothing for a part without', () => {
    const context = composeContext(protocol, directory, topic);
    expectTypeOf(context).parameter(0).toEqualTypeOf<{
      directory: string;
      topic: string;
    }>();
    expectTypeOf(composeContext(protocol, () => ['x']))
      .parameter(0)
      .toEqualTypeOf<Record<never, never>>();
    expectTypeOf(context).returns.toEqualTypeOf<
      Promise<readonly ContextContent[]>
    >();
    expectTypeOf(context).toExtend<
      ContextBlockFunction<{ directory: string; topic: string }>
    >();
  });

  it('does not compile without an input variable, or with a mistyped one', () => {
    const context = composeContext(directory, topic);
    // @ts-expect-error -- `topic` is missing
    void context({ directory: '/k' });
    // @ts-expect-error -- `topic` is a string
    void context({ directory: '/k', topic: 1 });
    const clashing = composeContext(
      directory,
      (_: { directory: number }) => [],
    );
    // @ts-expect-error -- `directory` cannot be a string and a number
    void clashing({ directory: '/k' });
  });
});

describe('resolveContextBlock', () => {
  it('defaults the tag, and sets a cache breakpoint when asked', async () => {
    expect(
      await resolveContextBlock(
        { context: 'x', cache: { type: 'ephemeral', ttl: '1h' } },
        cwd,
      ),
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
