# Defining and implementing a procedure

Reference: [ARCHITECTURE §3 Procedures](../../../../docs/ARCHITECTURE.md#3-procedures) and [§6 The runners](../../../../docs/ARCHITECTURE.md#6-the-runners). Worked examples: `golden-kata`'s [writer](../../../../packages/examples/golden-kata/agents/writer/agent/procedures.ts) and `smoke-coverage`'s [hello-agent](../../../../packages/examples/smoke-coverage/agents/hello-agent/agent/procedures.ts); on `strands`, `research-brief`'s [briefer](../../../../packages/examples/research-brief/agents/briefer/agent/procedures.ts). Sections 1–3 hold for both frameworks, with `claude`'s options, memory and Bash; section 4 is what differs on `strands`.

## 1. The contract

An agent's `contract.ts` is what callers import, so it holds no Agent SDK code: oRPC's `oc`, Zod, and `timeBudget` from `@beruangai/agentforge/contract`. Procedure names are `PascalCase`.

- **Every object is `z.strictObject` or `z.looseObject`.** `implementAgent` and `createClient` refuse a `z.object` anywhere in a contract, naming each place, because it drops undeclared keys silently.
- **Declare the time budget** with the procedure, `oc.meta(timeBudget(seconds))`, when the agent's default (an hour) is wrong for it.
- **The output is what the caller needs**, computed fields and identifiers included. The model fills in only the agent contract (below), and the handler builds the rest.
- **A domain "no" is an output**, never a failure.

## 2. The handler

A procedure imports from two entry points: `@beruangai/agentforge/agent` for what every framework shares — `filesystems` and the filesystem kinds, `composeContext` and `ContextBlockFunction`, `StopGuard`, `TaskFailure` — and its project's framework's, `@beruangai/agentforge/claude/agent` or `@beruangai/agentforge/strands/agent`, for `implementAgent`, `composeOptions`, `distill` and the framework's prompt and run types (`claude` adds `documentBlock`). A procedure written for one framework does not compile against another.

```ts
const os = implementAgent(contract); // from @beruangai/agentforge/claude/agent
export const router = os.router({
  Write: os.Write.handler(async ({ input, context }) => {
    const run = await context.runAgent({ prompt, output: AgentSchema, options });
    return { ...run.output, computed: compute(run.output) };
  }),
});
```

A handler is ordinary code. It runs before the agent, calls `context.runAgent` any number of times or none, and runs after it. The task's outcome is what the handler returns. Runs can go one after another, in parallel, or one feeding the next. That is the handler's own code.

### The agent contract

`runAgent`'s `output` is the agent contract: what the model submits as structured output. Keep it to what the model should fill in. Its root is an object. Use `.describe()` on fields the model needs explained. Plain `z.object` is fine here, since structured output closes every object.

### Options

Options are the framework's. For `claude` they are the Agent SDK's own `Options`, minus `outputFormat` and `abortController`, which the kernel owns. Compose them with `composeOptions`. Never spread them by hand.

```ts
options: composeOptions(baseOptions(directory), context.agentOptions, {
  tools: ['Write', 'Edit'],
  maxTurns: 20,
}),
```

- `baseOptions` comes from the base layer's scaffolded `options.ts`, which the project owns: model, `settingSources: ['project']`, MCP servers, base tools, `permissionMode: 'dontAsk'`, and the read fence.
- `context.agentOptions` holds the run options the framework derives from the mounts. For `claude`: each mount as an additional directory, and `Read` and `Edit` allow rules from its permissions. AgentForge applies none of it. Compose it in.
- Later parts win for scalars, objects merge, and **lists accumulate**. A narrower part cannot remove a hook or a tool rule a broader one set. An MCP server named twice throws.
- Keep `cwd` the agent's directory, the default, so the layers' `.claude/` compose. A resume must run from the same `cwd` as the session it resumes.
- **The run spec takes only its own fields**: `prompt`, `output`, `wrapNonObjectOutput`, `options`, `guardrails`, and the framework's extras (`claude`: `memoryDirectory`). Anything else fails the task `EXECUTION_ERROR`, naming it, even where a conditional spread got it past the type check. On `claude`, `resume` is an SDK option and goes in `options`; on `strands` it sits beside them.

### Context

Build a prompt from typed **context functions** and `composeContext`. A missing input variable is then a compile error.

```ts
const instructions: ContextBlockFunction = () => [
  { tag: 'instructions', filepath: '.claude/fragments/write-kata.md' },
];
const request: ContextBlockFunction<{ topic: string }> = ({ topic }) => [{ tag: 'topic', context: topic }];
export const writeContext = composeContext(instructions, request);
// prompt: await writeContext({ topic: input.topic })
```

- Static content goes first, with `cache: true` (an hour) or `cache: { ttl: '5m' }` on its last block, then what this run is about.
- A block with `filepath` is read from the layer's `.claude/` against the run's `cwd` when the run starts. One that can't be read fails the run.
- Who the agent is goes in `CLAUDE.md`, occasional know-how in a skill in the layer's `.claude/skills/`, and a procedure's role in its `systemPrompt`. AgentForge appends its own fragments after the system prompt. Never use the `claude_code` preset.

### Stop guards

A stop guard holds back the agent's answer until something outside the answer holds, such as a file it was told to write.

```ts
guardrails: {
  stop: [async () => (existsSync(kata.path(KATA_FILE)) ? undefined : { reason: `Write ${KATA_FILE} first.` })],
},
```

Every guard runs on every submission. Every reason goes back to the agent at once, and it submits again in the same turn. Past the CLI's retry limit, the task fails `OUTPUT_INVALID`. A guard that throws is a defect and fails the task `EXECUTION_ERROR`. Don't use an SDK `Stop` hook for this: a block after the submission is ignored.

### Filesystems

A procedure declares the files it works on, as middleware, and gets each mount on `context.filesystems.<name>`.

```ts
Write: os.Write.use(filesystems({ kata: new ScratchFilesystem() })).handler(async ({ input, context }) => {
  const { kata } = context.filesystems;
  // kata.localPath; kata.permissions: read on '**', edit on each write glob, relative to the mount
  // kata.path('a.md') resolves inside the mount; kata.writablePath('a.md') also inside the write scope
}),
```

- `ScratchFilesystem` is an empty directory of the task's own.
- An `S3Filesystem` mounts a bucket prefix. Declare shared options once (`localRoot`, `bucket`, optionally `remoteRoot`, and a `scope` returning `{ subpath, write? }`). Spread them per procedure, adding `pushOn` where it writes.
- A `GitFilesystem` mounts a subtree of one branch (`branch`, `main` by default) of a declared `repository`, and pushes the write scope as one commit onto the branch's tip, with trailers naming the task. Declare it **at module scope** in `procedures.ts`, never inside a handler: an `https://` remote's token, named by `tokenVariable`, is taken out of `process.env` when the filesystem is constructed, before any agent runs, and given to its own git alone. The token is a secret the agent's construct maps in `secrets`, but not one the layer's `REQUIRED_SECRETS` lists, so a local serve over a host repository needs none. `exclude` keeps paths out of every commit. A refused token fails `CREDENTIAL_EXPIRED`; another writer's change to a file the push also changed fails `FILESYSTEM_UNSYNCED`. Worked example: `smoke-coverage`'s [`KeepJournal`](../../../../packages/examples/smoke-coverage/agents/hello-agent/agent/procedures.ts).
- **The local copy is kept at unmount** for the next task of the same runtime session in that container, files outside the write scope included. Declare `removeLocalCopy: true` where a task must start from the store alone. A copy another runtime session or store left is removed before mounting. An S3 copy does not take another writer's deletions, and its push may restore them: a procedure sharing a prefix with writers that delete declares `removeLocalCopy` or partitions by subpath. A git copy keeps its own changes the branch did not make, and logs each it discards.
- **Deletes are off.** `dangerouslyEnableDeletes` makes a push record a file missing from the write scope as deleted, and adds a `delete` permission per write glob. No framework renders `delete`, so a deleting agent needs its own shell allow list, which the handler composes.
- **The agent's push.** A git mount whose `pushOn` includes `TASK_STATE_FAILED` offers the agent a push of its own: `context.agentOptions` carries an allowed `push_<name>` tool (`mcp__agentforge__push_<name>` on `claude`) taking `{ message }`, so partial work survives a run that fails later. Compose `context.agentOptions` into the run's options; a handler may also call `mount.push(message)`. The tool's full name must fit 64 characters, which bounds the filesystem's name.
- **Spawning from a handler**: use `node:child_process`, or pass `env` explicitly. A `Bun.spawn` child started without `env` inherits the process's startup environment, a git filesystem's token included.
- Use `path` and `writablePath` for the handler's own file access. They throw on a path that climbs out of the mount, or, for `writablePath`, on one outside the write scope that would never be pushed.
- The prefix is the consumer's to keep to one task at a time, through a `runtimeSessionId`, a continuity key, or a subpath per task. A second live task on the same local directory in a container is refused `FILESYSTEM_UNSYNCED`, retryable.

### Memory

A run that declares `memoryDirectory` keeps Claude Code's auto memory there. Usually it is an `S3Filesystem` over the deployment's memories bucket, with one subpath per memory space.

```ts
memoryDirectory: context.filesystems.memory.localPath,
```

Saving needs `Write` and `Edit` in `tools` and a `pushOn` on the filesystem. Without `memoryDirectory`, memory is off. Don't set `autoMemoryEnabled`, `autoMemoryDirectory` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY` yourself: the kernel owns them.

### Distill

```ts
const blocks = await distill(context, { documents, instruction: 'what answers the question', capTokens });
```

`distill` passes documents through whole when they fit the cap (12,000 tokens by default). Otherwise it compacts them, in one utility run, into a cited `distillation` block. Put the blocks first in the prompt.

### Bash and the read fence

The base options fence reads to the run's working directories. List the Bash commands a procedure allows in `allowedTools`. The fence refuses a command the CLI can't trace, such as `python -c` or `sh -c`, whatever the allow rules. So **code an agent runs ships as a file in its layer**, and the agent runs that file. Alternatively, the procedure turns the fence off in its own options: `settings: { permissions: { blockReadsOutsideWorkingDirectories: false } }`.

## 3. Side effects are code

Anything that happens because a run succeeded is the handler's own code, after the run: after `await`, or chained on it.

```ts
const run = await context.runAgent({ … });
await publish(run.output);                  // after await

return context.runAgent({ … }).then(async (run) => {
  await publish(run.output);                // or chained
  return toOutput(run);
});
```

AgentForge has no `onSuccess`, `before` or `after` hook. Only the handler knows what counts as success.

**Recovery is the consumer's.** A retried task under the same idempotency key gets `context.attempt` (1 on the first attempt) and `context.priorAttempt` (`{ taskId, state, cause? }`). Make side effects idempotent, or check what the prior attempt left before repeating it. A prior `LOST` means its side effects may have happened.

**End a task with a cause** by throwing `new TaskFailure(cause(code, message))`, with `cause` from `@beruangai/agentforge/contract`.

## 4. A `strands` procedure

The contract, the handler, context functions, stop guards, filesystems, `distill` and side effects are as above. What differs is the framework's: [ARCHITECTURE, the `strands` runner](../../../../docs/ARCHITECTURE.md#the-strands-runner).

- **Options** are AgentForge's `StrandsOptions`, not the SDK's `AgentConfig`: `model` and `maxTokens`, `modelConfig` for the provider's other settings, `systemPrompt`, `tools`, `mcpClients` by name, `plugins`, `hooks`, `interventions`, `conversationManager`, `limits` and `layers`. `composeOptions` composes them as `claude`'s does: lists accumulate, and an MCP client named twice throws. A hook is `hook(BeforeToolCallEvent, (event) => …)`, from `@beruangai/agentforge/strands/agent`, its callback typed by its event; the runner adds each with `agent.addHook`. `modelConfig` takes no `apiKey`, `client` or `clientConfig`: the runner owns the client. Every MCP client must start, and AgentForge connects and disconnects it. An option `StrandsOptions` does not have fails `EXECUTION_ERROR`, naming it. The base layer's `options.ts` sets the model.
- **Tools are the procedure's**, chosen from the SDK's vended ones (`fileEditor`, `makeShell()`) or its own `tool()`s. Nothing is on by default.
- **`context.agentOptions`** holds each mount as a working directory, named in the system prompt, and one Cedar intervention that refuses a `fileEditor` write outside the mounts' write globs, in the agent's turn. Compose it in. A shell command's writes are not bounded by it, and there is no read fence: which commands run is the procedure's to decide.
- **The layers** are Strands' names: each layer's `AGENTS.md`, base first, joins the system prompt after the procedure's own, and each layer's `.agent/skills/<skill>/SKILL.md` loads as a skill. AgentForge's fragments follow, among them the instruction to answer through the `strands_structured_output` tool: an answer given only as text ends the run `OUTPUT_INVALID`.
- **Extras** on `runAgent`: `memorySpace` keeps a memory space in the session bucket under `<agent>/memory/<space>/`, with the `search_memory` and `add_memory` tools, recalled by any later run that names it; `resume` takes the session id of an earlier run of the agent, in any of its containers; `offload` keeps tool results over `maxResultTokens` in storage, a preview in context; a storage call that fails, on any of them, fails the run `EXECUTION_ERROR`; `maxStructuredOutputAttempts` caps submissions, five by default.
- **A stop guard sees no submission.** It checks the world outside the answer, as on `claude`. A check on the answer's own content belongs in the agent contract, with a refinement, which refuses in the agent's turn.
- **The run record** has no `totalCostUsd`; `usage` holds the tokens. Read a run's session with `readSession(run)` from `@beruangai/agentforge/strands/client`.
