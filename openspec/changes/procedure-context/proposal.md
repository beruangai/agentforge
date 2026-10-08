# Proposal

## Why

What a consumer owns most directly is an agent's context: the static instructions and the dynamic content each procedure assembles into a prompt. AgentForge gives the pieces — tagged context blocks, documents, commands — but no standard way to compose them. TrendBot's predecessor shows where that leads ([lineage](../../../docs/lineage/predecessor-harness.md)): each agent has its own composer that follows a common pattern only by convention, and loading static fragment files took a bespoke path-resolving loader. A shared, type-safe way to define and compose context pieces lets a procedure call one function, with its inputs checked at compile time, instead of building context by hand.

The same holds on a smaller scale for a run's options. Since the read fence, every procedure with a mount spreads two task-derived values into its options, `context.filesystemDirectories` and `context.filesystemPermissions.allow`. They are always used together, so AgentForge should give them as one value.

## What Changes

- **Context functions** (new §REQ210). A `ContextBlockFunction` takes typed input variables and returns prompt content: text, content blocks and tagged context blocks. `composeContext(...functions)` returns one context function. Its input is every input the composed functions need, and its output is their content in the order given. A composite composes again. A procedure calls it and places the result in its prompt, or in a command's context. There is no templating, no builder class and no rendering of messages: the kernel still renders the prompt.
- **A context block may take its content from a file.** `{ tag: 'protocol', name: 'dates', filepath: '../.claude/fragments/dates.md' }` renders exactly as the same block with its text inline. The file is read when the run starts, resolved against the run's `cwd` as a context document is. A file that cannot be read fails the run before the agent starts. Static protocol atoms are then plain blocks in a context function.
- **A command's context takes content blocks too**, so a composite's output fits there as well as at the top of the prompt.
- **`context.agentOptions`** (new §REQ211) replaces `context.filesystemPermissions` and `context.filesystemDirectories`. It holds only what AgentForge derives from the task: every mount as an additional directory, and the mounts' baseline rules as allowed tools. The handler composes it into a run's options: `composeOptions(baseOptions(), context.agentOptions, { … })`. AgentForge still applies nothing itself. `context.filesystems.<name>` stays for per-mount use. **BREAKING** for the two removed fields; no consumer is live.
- **Guidance on where static instructions live**: the `CLAUDE.md` layers, skills, the procedure's system prompt, or file-backed blocks in the prompt, and how to order a prompt for caching.
- **golden-kata** lands it. The writer and the grader keep their procedure instructions as fragment files in their layers. A shared kata context function sits in the base layer. Each procedure's prompt is one composite. Both examples move to `context.agentOptions`.

## Capabilities

### New Capabilities
- `harness-context-composition`: an agent's context composed from typed, reusable context functions, with static content read from files.

### Modified Capabilities
- `filesystem-lifecycle`: the handler receives its mounts' directories and baseline rules as one set of run options it composes, rather than as two separate values.

## Impact

- **Interface (`/agent`)**:
  - new: `ContextBlockFunction`, `ContextContent` and `composeContext`;
  - `ContextBlock` gains `filepath` as the alternative to `context`, and `CommandBlock.context` takes content blocks;
  - `TaskContext.agentOptions` replaces `filesystemPermissions` and `filesystemDirectories`.

  The prompt types are where a procedure already says what the agent is asked. The task context is where it already learns what AgentForge derived for the task.
- **Kernel**: reads a file-backed context block when it renders the prompt, as it reads documents. Nothing else changes in a run.
- **Plugin**: the base-options scaffold's comment names `context.agentOptions`, with its snapshot.
- **No change** to the A2A contract, the task protocol, the runtime or the infrastructure.
- **Requirements**:
  - serves §REQ210 and §REQ211, both new and proposed for the operator;
  - keeps §REQ203: a run starts from exactly what the procedure composed;
  - keeps §REQ401: the handler still decides what a run is given.
- **Open options:** none depended on.

## Non-goals

- Templating: variables inside fragment files, or a template syntax. A context function is the typed template.
- A builder or chain class, or rendering blocks or a user message outside the kernel.
- Loading fragments by directory or glob. An explicit ordered list is the protocol.
- Runtime validation of a context function's inputs. They come from the procedure's already-validated input, and the types check them.
- A scaffolded context module in generated projects. It can follow once a second project shows its shape.
- Applying `context.agentOptions` to a run automatically.
