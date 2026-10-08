# Defining and implementing a procedure

Reference: [ARCHITECTURE §3 Procedures](../../../../docs/ARCHITECTURE.md#3-procedures) and [§6 The kernel](../../../../docs/ARCHITECTURE.md#6-the-kernel). Worked examples: `golden-kata`'s [writer](../../../../packages/examples/golden-kata/agents/writer/agent/procedures.ts) and `smoke-coverage`'s [hello-agent](../../../../packages/examples/smoke-coverage/agents/hello-agent/agent/procedures.ts).

## 1. The contract

An agent's `contract.ts` is what callers import, so it holds no Agent SDK code: oRPC's `oc`, Zod, and `timeBudget` from `@beruangai/agentforge/contract`. Procedure names are `PascalCase`.

- **Every object is `z.strictObject` or `z.looseObject`.** `implementAgent` and `createClient` refuse a `z.object` anywhere in a contract, naming each place, because it drops undeclared keys silently.
- **Declare the time budget** with the procedure, `oc.meta(timeBudget(seconds))`, when the agent's default (an hour) is wrong for it.
- **The output is what the caller needs**, computed fields and identifiers included. The model fills in only the agent contract (below), and the handler builds the rest.
- **A domain "no" is an output**, never a failure.

## 2. The handler

```ts
const os = implementAgent(contract);
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

Options are the Agent SDK's own `Options`, minus `outputFormat` and `abortController`, which the kernel owns. Compose them with `composeOptions`. Never spread them by hand.

```ts
options: composeOptions(baseOptions(directory), context.agentOptions, {
  tools: ['Write', 'Edit'],
  maxTurns: 20,
}),
```

- `baseOptions` comes from the base layer's scaffolded `options.ts`, which the project owns: model, `settingSources: ['project']`, MCP servers, base tools, `permissionMode: 'dontAsk'`, and the read fence.
- `context.agentOptions` holds the run options AgentForge derives from the task: each mount as an additional directory, and its baseline allow rules. AgentForge applies none of it. Compose it in.
- Later parts win for scalars, objects merge, and **lists accumulate**. A narrower part cannot remove a hook or a tool rule a broader one set. An MCP server named twice throws.
- Keep `cwd` the agent's directory, the default, so the layers' `.claude/` compose. A resume must run from the same `cwd` as the session it resumes.

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

- Static content goes first, with `cache: true` on its last block, then what this run is about.
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
  // kata.localPath; kata.path('a.md') resolves inside the mount; kata.writablePath('a.md') also inside the write scope
}),
```

- `ScratchFilesystem` is an empty directory of the task's own.
- An `S3Filesystem` mounts a bucket prefix. Declare shared options once (`localRoot`, `bucket`, optionally `remoteRoot`, and a `scope` returning `{ subpath, write? }`). Spread them per procedure, adding `pushOn` where it writes.
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
