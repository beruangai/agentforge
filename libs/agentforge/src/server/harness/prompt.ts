/**
 * A cache breakpoint on a block: `true` is one hour, or a TTL named. Each
 * framework renders it in its own terms; under `claude`, Claude Code places
 * one-hour breakpoints of its own after the prompt, and the API refuses a
 * shorter one before a longer, so a `5m` breakpoint fails the run.
 */
export type CacheBreakpoint = boolean | { readonly ttl: '5m' | '1h' };

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
  /** Never an attribute: a `type` makes the object a framework's own content. */
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

/** Content every framework takes in a prompt or a context function's output. */
export type ContextContent = string | ContextBlock;

/**
 * A piece of an agent's context: input variables in, prompt content out — the
 * shared content, or `Content` of a framework's own. One without input takes
 * none: `const rules: ContextBlockFunction = () => […]`.
 */
export type ContextBlockFunction<
  Input extends object = Record<never, never>,
  Content = never,
> = (
  input: Input,
) =>
  | readonly (ContextContent | Content)[]
  | Promise<readonly (ContextContent | Content)[]>;

/** Every input variable a list of context functions needs, as one object type. */
export type ComposedInput<
  Functions extends readonly ContextBlockFunction<never, unknown>[],
> = [Functions[number]] extends [never]
  ? Record<never, never>
  : Flatten<UnionToIntersection<InputOf<Functions[number]>>>;

/**
 * One context function from several: its input is every input variable any of
 * them needs, its output each one's content in the order given, of whatever
 * content types they return. The parts are evaluated concurrently, and a
 * composite composes again.
 */
export function composeContext<
  const Functions extends readonly ContextBlockFunction<never, unknown>[],
>(
  ...functions: Functions
): (
  input: ComposedInput<Functions>,
) => Promise<readonly ContentOf<Functions[number]>[]> {
  return async (input) =>
    (
      await Promise.all(
        functions.map((contextFunction) => contextFunction(input as never)),
      )
    ).flat() as readonly ContentOf<Functions[number]>[];
}

/** A function's input; none when it declares no parameter. */
type InputOf<Function> = Function extends (input: infer Input) => unknown
  ? unknown extends Input
    ? Record<never, never>
    : Input
  : never;

/** The content a context function returns. */
type ContentOf<Function> = Function extends (input: never) => infer Returned
  ? Awaited<Returned> extends readonly (infer Content)[]
    ? Content
    : never
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
