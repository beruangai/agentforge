# Design

## Context

See proposal.md — Why. What holds today:

- **The kernel** (`runAgent`) passes a procedure's `options.systemPrompt` and `options.settings` through untouched. It logs the system prompt it was given with the prompt (`agentforge.prompt`), and the run record carries its hash. It already owns `outputFormat` and `abortController`, and sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` in every run's `env`.
- **Auto memory in an SDK run** ([research](../../../docs/research/claude-agent-sdk.md), 2026-10-01):
  - `settings: { autoMemoryDirectory }` points it at an absolute directory, and `init.memory_paths.auto` reports it.
  - `MEMORY.md` loads under any system prompt.
  - Saving needs instructions, which a fragment in a custom system prompt supplies; verified both alone and after a procedure's own prompt.
  - Writes there need no allow rule under `dontAsk`.
  - When unset, the directory defaults to `~/.claude/projects/<cwd>/memory/`, inside the container. Claude Code's `autoMemoryEnabled` setting and its `CLAUDE_CODE_DISABLE_AUTO_MEMORY` variable turn auto memory off.
- **Filesystems** ([filesystem-lifecycle](../../specs/filesystem-lifecycle/spec.md)) give a handler `context.filesystems.<name>.localPath`, an absolute directory pulled before the handler and pushed on the states it declares. The deployment names a filesystem's bucket (`AgentRuntime`'s `filesystems`).

## Goals / Non-Goals

**Goals:**
- One declaration on a run gives it working auto memory, with the instructions and the settings together.
- A run that declares nothing is unchanged, apart from auto memory being off.

**Non-Goals:**
- Choosing a memory space, its push states or its delete policy for the consumer: the filesystem declares them.
- Testing what the model chooses to remember. Tests assert that a told fact is kept and recalled, not how the agent words it.

## Decisions

### A run declares a directory, not a filesystem

```ts
export interface AgentRunSpec<Output> {
  // …as today
  /**
   * An absolute directory to keep Claude Code's auto memory in, usually a
   * mounted filesystem's `localPath`: its `MEMORY.md` index is in context
   * from the first turn, and the agent is told how to keep it (§REQ404).
   * Without it, auto memory is off.
   */
  readonly memoryDirectory?: string;
}
```

A procedure declares durability where it already does, as a filesystem:

```ts
Remember: os.Remember.use(
  filesystems({
    memory: new S3Filesystem({
      localPath: '/workspace/memory',
      bucket: 'memories',
      scope: ({ input }) => ({ remotePath: `spaces/${input.space}` }),
      pushOn: ['TASK_STATE_COMPLETED'],
    }),
  }),
).handler(async ({ input, context }) => {
  await context.runAgent({
    prompt: …,
    output: …,
    memoryDirectory: context.filesystems.memory.localPath,
    options: { tools: ['Read', 'Write', 'Edit'], permissionMode: 'dontAsk' },
  });
})
```

*Alternatives:*
- **A `MountedFilesystem` instead of a path.** It would tie memory to a mount AgentForge made, but nothing in the kernel needs more than the path. A test, or a `ScratchFilesystem`, gives a directory the same way.
- **A memory filesystem kind or helper** with a default bucket, path and push states. It saves a consumer four lines, at the cost of a second way to write an `S3Filesystem` and of defaults that hide the push and delete choices that matter for memory. Not built.

### A registry of system-prompt fragments ([ADR 0017](../../../adr/0017-agentforge-adds-system-prompt-fragments-never-the-preset.md), proposed)

```ts
// server/harness/system-prompt.ts
interface SystemPromptFragment {
  /** Names the fragment in errors and logs. */
  readonly name: string;
  /** The fragment's text for this run, or undefined when the run does not call for it. */
  render(spec: AgentRunSpec<unknown>): string | undefined;
}

const SYSTEM_PROMPT_FRAGMENTS: readonly SystemPromptFragment[] = [AUTO_MEMORY_FRAGMENT];

/** The procedure's system prompt with every fragment the run calls for appended. */
export function composeSystemPrompt(spec: AgentRunSpec<unknown>): Options['systemPrompt'];
```

`composeSystemPrompt` renders every fragment and, when at least one applies, appends them to the procedure's own prompt:

| Procedure's `systemPrompt` | Result |
|---|---|
| absent | the fragments, as `string[]` |
| `string` | `[prompt, ...fragments]` |
| `string[]` | `[...prompt, ...fragments]` |
| `{ type: 'custom', prompt }` | the same object, with `prompt` extended the same way |
| `{ type: 'preset' }` | throws, naming the preset and each fragment |

When no fragment applies, the procedure's prompt passes through untouched, so a run that declares nothing is the same prompt it is today. The kernel calls `composeSystemPrompt` once per run. It logs the result in `agentforge.prompt` and passes it to the SDK, so the recorded hash is of the prompt the agent received.

The auto-memory fragment is the spike's text, which names the directory, when to save, the file format with its frontmatter, the index rule and the update-don't-duplicate rule. It is held as a template over the directory. A `string[]` keeps the fragment its own block, which is how the spike verified it.

*Alternatives:* the preset ([ADR 0017](../../../adr/0017-agentforge-adds-system-prompt-fragments-never-the-preset.md)); a single hard-coded memory branch in the kernel. The registry is the operator's ask, and costs one array and one interface.

### The kernel owns the auto-memory settings

On every run:

- With `memoryDirectory`, the kernel merges `{ autoMemoryEnabled: true, autoMemoryDirectory }` into `options.settings`. The directory must be absolute.
- Without it, the kernel sets `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in `env`, beside `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`. That turns auto memory off, so no index from the container's default directory loads (§REQ403). It works whatever form `settings` takes.
- A procedure that sets either key in its `settings`, or the variable in its `env`, is refused. So is one whose `settings` is a file path while it declares a directory, since the kernel cannot merge into a file.

The refusal is the pattern `outputFormat` set: a capability the kernel provides is declared one way, and a second way would be either ignored or contradicted.

### Persistence is the filesystem's

Nothing in this change syncs memory. An `S3Filesystem` pulls the space before the handler and pushes on the states the procedure declares. A memory saved in a task that ends in an undeclared state is lost, as any filesystem's write would be.

The deployment declares one memories bucket through `S3FilesystemBucket`, passed to every agent that keeps memory as `filesystems: { memories }`. Spaces are prefixes the consumer's scope computes. The `smoke-coverage-infra` stack adds that bucket beside `notebook`, with its name among the stack's outputs and the buckets its destroy empties.

## Error handling

Every refusal is thrown by the kernel before `query()` is called, as a `TaskFailure` with cause `EXECUTION_ERROR` (not retryable: the procedure's code is wrong).

| Failure | Outcome |
|---|---|
| `memoryDirectory` is not absolute | `EXECUTION_ERROR`, naming the directory |
| `memoryDirectory` under the `claude_code` preset | `EXECUTION_ERROR`, naming the preset and the memory fragment |
| `autoMemoryEnabled` or `autoMemoryDirectory` in the procedure's `settings` | `EXECUTION_ERROR`, naming the key and pointing to `memoryDirectory` |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` in the procedure's `env` | `EXECUTION_ERROR`, naming the variable |
| `settings` a file path while `memoryDirectory` is declared | `EXECUTION_ERROR`, naming the path |
| The memory filesystem fails to pull or push | As today: the task fails before the handler, or ends `FILESYSTEM_UNSYNCED` |

## What earns which test

- **Model `integ`, because it can drift:** `integ/model/auto-memory/`, through `runAgent`. It checks that Claude Code still honours the directory and AgentForge's own instructions; both are undocumented as a combination and can change with a CLI release.
  - A run with a memory directory, `Write` and `Edit`, told a fact to remember, leaves a topic file and a `MEMORY.md` line in the directory. A second run with the same directory and no tools answers with the fact.
  - A run with no memory directory reports no `memory_paths.auto` in its `init`. The variable's effect is documented, but AgentForge's §REQ403 claim rests on it, and the check costs no extra run: it is read from the second test's run of the cheapest model.
- **e2e on AgentCore:** `smoke-coverage`'s `Remember` saves a fact in one task. The suite stops its container. `Recall` in a new runtime session, so another container, answers with it. Locally the example has no S3 (§ODO009), so the local suite does not cover it, as it does not cover the notebook.
- **Unit:**
  - `composeSystemPrompt` for each form in the table, and with no fragment applying;
  - the kernel passing the settings or the variable, and each refusal in the table;
  - the logged and recorded system prompt being the composed one.
- **Settled once, a research note:** the spike's findings are already dated in `research/claude-agent-sdk.md`. The variable that disables auto memory is added there.

## Risks / Trade-offs

- [Two tasks write one space at once; the later push overwrites the earlier one's `MEMORY.md`, and a memory file is orphaned from the index] → Isolation is the consumer's. The documented way is a continuity key per space, which AgentForge already enforces as one live task.
- [The agent deletes a wrong memory, but with deletes off the next pull brings it back] → `dangerouslyEnableDeletes` on the memory filesystem propagates deletes, subject to the same concurrency caveat. The choice is the consumer's, and the docs say so.
- [Claude Code changes how auto memory works, and the fragment's instructions go stale] → The model integ test notices on the next pre-publish run. The fragment lives in one place.
- [Memory grows past the 200 lines or 25 KB of `MEMORY.md` Claude Code loads] → The fragment keeps the index to one line per memory, under 200 lines. Beyond that, Claude Code's own truncation applies.

## Migration Plan

None. A run that declares no memory differs only in auto memory being off. It was effectively off before: a fresh container's default directory holds nothing, and nothing told the agent to save.
