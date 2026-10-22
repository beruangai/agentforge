import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  type ContextBlockFunction,
  type ContextContent,
  composeContext,
} from './prompt.ts';

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

describe('composeContext over a framework’s content', () => {
  it('passes the framework’s content through, typed', async () => {
    type Own = { readonly type: 'own'; readonly value: number };
    const own: ContextBlockFunction<Record<never, never>, Own> = () => [
      { type: 'own', value: 1 },
    ];
    const context = composeContext(() => ['shared'], own);
    expect(await context({})).toEqual(['shared', { type: 'own', value: 1 }]);
    expectTypeOf(context).returns.toEqualTypeOf<
      Promise<readonly (ContextContent | Own)[]>
    >();
  });
});
