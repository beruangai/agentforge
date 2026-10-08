# Design

## Context

See proposal.md — Why. What holds today:

- **The prompt.** `AgentPrompt` is one `PromptContent` or an ordered list: a string, a content block (text, image, inline document), a `ContextBlock`, or a `CommandBlock`.
  - `ContextBlock` (`{ tag?, description?, context, cache?, ...attributes }`) renders as `<tag attr="…">\n…\n</tag>`.
  - `ContextDocument` (`{ filepath, title?, context?, cache? }`) is read from a file against the run's `cwd` and becomes a `document` block. It appears only in `CommandBlock.documents`, and an unreadable file throws, which fails the task `EXECUTION_ERROR`.
  - `CommandBlock.context` takes strings and context blocks.
  - The kernel renders it all into one user message (`createUserMessage`).
- **The task context.** The registry middleware gives the handler `context.filesystems`, `context.filesystemPermissions.allow` and `context.filesystemDirectories`. Every procedure with a mount spreads the last two into its options.
- **Where files are.** An agent's `$claude/` becomes `/workspace/agentic/agent/.claude/` in its image, and the base layer's becomes `/workspace/agentic/.claude/`. The agent's `cwd` is `/workspace/agentic/agent`, and the task process — the handler — runs in the same image. So a fragment the handler names relative to the run's `cwd` resolves the same way under `serve` and on AgentCore. TrendBot needed a host-to-container path loader only because its procedures ran outside the image.
- **The predecessor's composers** (`agent/discovery/context.ts` there) are pure typed functions returning tagged blocks, in tiers: cross-agent protocol atoms, then agent and procedure fragments, then lane- and run-specific dynamic blocks. The dynamic blocks are placed as the directive command's context. None of its fragments has a variable.

## Goals / Non-Goals

**Goals:**
- One type a consumer satisfies for every piece of context, and one way to compose pieces, with inputs checked at compile time.
- Static fragments as plain blocks, read where the run runs.
- One value for what AgentForge derives for a run.

**Non-Goals:** as in proposal.md.

## Decisions

### Context functions return prompt content, not rendered blocks

```ts
// server/harness/prompt.ts

/** Content that may stand in a prompt or in a command's context. */
export type ContextContent = string | ContentBlock | ContextBlock;

/** A piece of an agent's context: input variables in, prompt content out. */
export type ContextBlockFunction<Input extends object = Record<never, never>> = (
  input: Input,
) => readonly ContextContent[] | Promise<readonly ContextContent[]>;

/** Every input a list of context functions needs, as one object type. */
type ComposedInput<Functions extends readonly ContextBlockFunction<never>[]> =
  UnionToIntersection<Parameters<Functions[number]>[0]>;

/**
 * One context function from several: its input is every input any needs, its
 * output each one's content in the order given. Evaluated concurrently.
 */
export function composeContext<
  const Functions extends readonly ContextBlockFunction<never>[],
>(...functions: Functions): ContextBlockFunction<ComposedInput<Functions>>;
```

In use:

```ts
const kataProtocol: ContextBlockFunction = () => [
  { tag: 'protocol', name: 'kata-files', filepath: '../.claude/fragments/kata-files.md', cache: true },
];
const kataDirectory: ContextBlockFunction<{ directory: string }> = ({ directory }) => [
  { tag: 'kata-directory', context: directory },
];
export const kataContext = composeContext(kataProtocol, kataDirectory);
// (input: { directory: string }) => Promise<readonly ContextContent[]>

const prompt = [
  ...(await composeContext(kataContext, topicContext)({ directory, topic: input.topic })),
  'Write the kata, then answer with it.',
];
```

A context function returns `ContextContent`, which `runAgent` renders: not API blocks, and not a message. File-backed blocks are therefore read where every other file the prompt names is read, against the run's `cwd`. Cache markers stay where the function placed them, and nothing renders twice. A `CommandBlock` is not `ContextContent`: the command is the procedure's directive, and a composite's output goes into its context.

`ComposedInput` is the intersection of the parts' inputs. A function with no input (`Record<never, never>`) adds nothing. Two parts that name the same variable with different types intersect to an unsatisfiable type, which a call cannot satisfy. That is a compile-time error, not a runtime surprise. The composite evaluates its parts with `Promise.all` and concatenates them in order, so a part that reads a store or a file does not wait for the others.

The type-level tests sit beside the unit tests (`expectTypeOf`, and `@ts-expect-error` for a missing variable). They run as part of the package's typecheck.

*Alternatives:*
- **A chain or builder class** (`fromChain`, `fromStatic`, `fromDynamic`, `renderBlocks`). Each `from*` is a context function with a different shape. `renderBlocks` and `renderMessage` duplicate what the kernel does, outside the place the run's `cwd` is known.
- **Templates with `{{variables}}`.** A second language, typed only by a schema kept beside it, and Mustache renders a missing variable as empty. A typed function is the template.
- **Returning API content blocks.** It would read files before the run, against a `cwd` the function does not know, and lose the context-block form a command's context takes.

### A context block names a file instead of carrying its text

```ts
export type ContextBlock = {
  readonly type?: never;
  readonly tag?: string;
  readonly description?: string;
  readonly cache?: CacheBreakpoint;
  readonly [attribute: string]: unknown;
} & (
  | { readonly context: string; readonly filepath?: never }
  /** Absolute, or relative to the run's `cwd`; read when the run starts. */
  | { readonly filepath: string; readonly context?: never }
);
```

`filepath` joins the reserved keys, so it is never an attribute. Rendering reads the file (UTF-8) and renders the block as if `context` held it. Its place is decided by the kernel's prompt rendering: in `resolveContent` and in `resolveCommandBlock`'s context entries, which become async for it. A block with both keys or neither is refused at render time, so a block built from untyped data fails rather than rendering empty.

*Alternative:* reusing `ContextDocument` for fragments. A document block is a citable source with a title, and is the wrong shape for an instruction.

### A command's context takes content blocks

`CommandBlock.context` widens from `string | ContextBlock | (string | ContextBlock)[]` to `ContextContent | readonly ContextContent[]`. Content blocks pass through in place, after the command text, as top-level ones do. TrendBot's directive carried the dynamic blocks as its context; a composite's output may include a content block, such as an image.

### `context.agentOptions` replaces the two filesystem values

```ts
export interface TaskContext {
  // …as today, without filesystemPermissions and filesystemDirectories
  readonly filesystems: Readonly<Record<string, MountedFilesystem>>;
  /**
   * The run options AgentForge derives from this task — every mount as an
   * additional directory, every mount's baseline rules as allowed tools —
   * to compose into a run's own. Empty without mounts. AgentForge applies
   * none of it: the handler decides (ADR 0015).
   */
  readonly agentOptions: Readonly<
    Pick<AgentOptions, 'additionalDirectories' | 'allowedTools'>
  >;
}
```

Without mounts it is `{}`, not empty lists, so composing it changes nothing. It holds only what is derived from the task. House defaults such as `permissionMode` or the read fence belong to base options, and `memoryDirectory` is a run field, not an SDK option. A run that should not get the mounts, such as `distill`'s, does not compose it.

[ADR 0015](../../../adr/0015-filesystems-mount-around-a-procedure.md)'s "the handler owns the agent's permissions" holds: the handler still passes them. The ADR is mutated in place to name `context.agentOptions`.

*Consequence in golden-kata:* the grader composes its scratch mount's `Edit` rules too, because the mount's default write scope is everything. That is harmless, since the grader has no `Write` or `Edit` tool, but it is broader than today.

### Where static instructions live

Written into the root README's "implement" step, beside the context functions:

| What | Where | Why |
|---|---|---|
| Who the agent is, and rules for every run of an agent or project | `CLAUDE.md` in the layer's `.claude/` | Loaded by Claude Code for every run through `settingSources`, composed across layers |
| Know-how the agent needs only sometimes | A skill in the layer's `.claude/skills/` | Loaded when relevant, not in every prompt |
| The procedure's role and standing instructions for its runs | The procedure's `systemPrompt` | Per procedure; AgentForge appends its own fragments after it |
| Protocols and contracts a procedure's prompt carries | File-backed context blocks, first in the prompt | Explicit, ordered, versioned with the layer |
| What this run is about | Dynamic context functions, after the static ones | Per run |

Static content goes first with a cache breakpoint on its last block, and dynamic content after, so a prompt's stable prefix is cached across runs.

### golden-kata

- **The base layer** gains `context.ts`, exported as `@beruangai/golden-kata-base/context`. It holds `kataContext`, the kata files' contract and the directory a run works in. The contract is a file-backed `protocol` block from the base layer's `$claude/fragments/kata-files.md`, moved out of `CLAUDE.md`, which keeps who the agent is.
- **The writer and the grader** keep their procedure instructions in `$claude/fragments/` of their own layers: how to write and check a kata, and how to grade one. Each composes `kataContext` with its own dynamic function: the topic and difficulty for the writer, the kata for the grader.
- **Every procedure** in both examples composes `context.agentOptions`.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| A file-backed block's file cannot be read | rendering the prompt, before `query()` | the run throws, naming the file; the task fails `EXECUTION_ERROR`, as an unreadable document does |
| A context block with both `context` and `filepath`, or neither | rendering the prompt | the same |
| A context function throws or rejects | when the procedure calls it | the procedure's error, as any of its code's |
| A missing or mistyped input variable | compile time | a type error |

## What earns which test

- **Unit:**
  - `composeContext`: order across sync and async parts, nesting, and an empty composition. The type tests cover the intersected input, a missing variable, and a no-input part.
  - A file-backed block, relative and absolute: it renders exactly as the inline block, `filepath` is not an attribute, and the same holds inside a command's context. An unreadable file, both keys and neither key each fail before `query()`.
  - A command's context with a content block.
  - `context.agentOptions` with two mounts and with none.
  - The scaffold snapshot.
- **e2e:** golden-kata locally and on AgentCore. It proves fragment files resolve from the agent's and the base layer's `.claude/` in the built image, and that the composed prompts still produce graded katas. smoke-coverage locally and on AgentCore covers `context.agentOptions` with its notebook and memory mounts.
- **No integration test.** Nothing here relies on platform behaviour that can drift: the files are read by AgentForge, and the prompt the model receives is the same blocks as before.

## Risks / Trade-offs

- [Moving golden-kata's file contract from `CLAUDE.md` into a prompt fragment changes what its agents see] → The e2e verifies they still write and grade katas. The move is the guidance applied, not a requirement.
- [`UnionToIntersection` types are opaque in editor hovers] → `ComposedInput` is a named type; the docs show the resolved input.
- [**BREAKING** removal of the two context fields] → No consumer is live. The examples and the scaffold's comment move in this change.
