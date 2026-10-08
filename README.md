# AgentForge

Run a Claude Agent SDK procedure as an asynchronous, typed task — locally in Docker or on Bedrock AgentCore — and call it from anything, Temporal included.

Built for its consumers, StrategyFoundry and TrendBot, not for public use. **Status:** A1–A4 delivered — the whole path runs locally and on AgentCore, with filesystems, against a real model, specified and audited — A5's baseline: the Nx plugin generates, syncs and deploys agentic projects, AgentForge's own [examples](packages/examples) among them — and A6, what must hold before the first live consumer, but its Claude plugin ([roadmap](docs/ROADMAP.md)).

## Define, implement, consume

**1. Define a contract** — what callers import. Plain oRPC and Zod; no Agent SDK.

```ts
// contract.ts
import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';

export const contract = {
  summarise: oc
    .input(z.strictObject({ text: z.string(), resumeSessionId: z.string().optional() }))
    .output(z.strictObject({ summary: z.string(), words: z.number(), sessionId: z.string() })),
  sleepThenAnswer: oc.meta(timeBudget(300)).input(…).output(…),
};
```

Every object in a contract is `z.strictObject` or `z.looseObject`: `z.object` drops an undeclared key silently, so a contract holding one is refused (§REQ103).

**2. Implement it** — a handler per procedure. `context.runAgent` is one Claude run with structured output; everything around it is ordinary code.

```ts
// procedures.ts
import { implementAgent } from '@beruangai/agentforge/agent';

const os = implementAgent(contract);
export const router = os.router({
  summarise: os.summarise.handler(async ({ input, context }) => {
    const run = await context.runAgent({
      prompt: ['Summarise the text in one sentence.', { tag: 'text', context: input.text }],
      output: z.object({ summary: z.string() }),          // what the model fills in; an object root
      options: { maxTurns: 3, tools: [], resume: input.resumeSessionId },
    });
    return { summary: run.output.summary, words: countWords(run.output.summary), sessionId: run.sessionId };
  }),
  …
});
```

A prompt is built from **context functions** — typed input variables in, prompt content out — and `composeContext` makes one from several: its input is every variable its parts need, checked when the procedure compiles, and its content theirs in order. A context block may name a file in its layer's `.claude/` instead of carrying its text; it is read against the run's `cwd` when the run starts, and one that cannot be read fails the run. A procedure with filesystems composes `context.agentOptions` — its mounts as `additionalDirectories` and their baseline rules — into the run's options.

```ts
const protocol: ContextBlockFunction = () => [
  { tag: 'protocol', name: 'kata-files', filepath: '../.claude/fragments/kata-files.md', cache: true },
];
const request: ContextBlockFunction<{ topic: string }> = ({ topic }) => [{ tag: 'topic', context: topic }];
const writeContext = composeContext(protocol, request);   // (input: { topic: string }) => Promise<…>

await context.runAgent({
  prompt: await writeContext({ topic: input.topic }),
  output: KataSchema,
  options: composeOptions(baseOptions(), context.agentOptions, { maxTurns: 20 }),
});
```

| Static instructions | Where |
|---|---|
| Who the agent is; rules for every run of an agent or project | `CLAUDE.md` in the layer's `.claude/`, composed across layers |
| Know-how needed only sometimes | A skill in the layer's `.claude/skills/` |
| A procedure's role and standing instructions | Its `systemPrompt`; AgentForge appends its own fragments after it |
| Protocols and contracts a prompt carries | File-backed context blocks, first in the prompt |

What a run is about follows, from dynamic context functions. Static content first with a cache breakpoint on its last block keeps a prompt's stable prefix cached across runs. [`golden-kata`](packages/examples/golden-kata) composes its prompts this way.

**3. Package it** — two entries, a `package.json` and its generated `bun.lock` (the container workspace's, up to this agent), and a Dockerfile `FROM agentforge/a2a-claude` that copies them to `/workspace/agentic/agent` and installs.

```ts
// task.ts — run by the server, once per task
runTaskProcess({ contract, router });
// server.ts — the container's entry; names the task entry and the secrets its layers require, the rest from the environment
await startServer({ taskEntry: new URL('./task.ts', import.meta.url), requiredSecrets });
```

**4. Consume it** — from any process, or as a Temporal activity.

```ts
import { contract as helloAgent } from '@beruangai/smoke-coverage/hello-agent';   // generic at the seam, named by the importer
const client = createClient(helloAgent, localTransport('http://localhost:9000/'));   // or agentCoreTransport({ agentRuntimeArn })
const started = await client.summarise.SendMessage({ text }, { runtimeSessionId, idempotencyKey });
const ended = await awaitTask(client.summarise, started, { runtimeSessionId });
if (ended.state === 'TASK_STATE_COMPLETED') ended.output.summary;  // typed
else if (ended.state === 'TASK_STATE_FAILED') ended.cause.code;    // OUTPUT_INVALID, TIMED_OUT, LOST, USAGE_LIMITED, …
ended.image; ended.runs;  // the image it ran in; each agent run's record

// In a Temporal worker: start-or-attach keyed by the workflow run and activity, heartbeats, a cancel the workflow requests, retry guidance
export const summarise = procedureActivity(client.summarise, {
  cancelTask: client.CancelTask,
});
// …which a workflow calls with the input and that call's routing
await summarise(input, { runtimeSessionId: sessionFor(input) });
```

A start the container cannot run now — stopping, full, or already running the start's continuity key — is **refused** with when to retry, leaving no task: the client throws `StartRefusedError`; the activity waits it out, up to 15 minutes per attempt, then fails retryable after the refusal's time. So give the activity a `startToCloseTimeout` covering the procedure's time budget plus those 15 minutes, and leave `maximumAttempts`, `scheduleToCloseTimeout` and the workflow's timeouts unset or wide enough for several attempts: workflow code cannot widen them once the activity is scheduled ([research](docs/research/temporal.md)).

The Nx plugin generates and maintains all of this (the [package README](libs/agentforge/README.md#the-nx-plugin)); [`packages/examples/smoke-coverage`](packages/examples/smoke-coverage) is this agent, generated, with its e2e.

## Known limits

Built to what the platforms document, with tests only where AgentForge relies on something they leave unsaid. Report what hits, and it is triaged in the layer that owns it.

- **Resume uses the session's working directory.** A transcript is keyed by the directory its session began in — the agent's own unless a procedure sets `cwd` — and a resume must run from the same one.
- **Files do not follow a session.** A resumed session remembers what earlier runs wrote, but a new container does not have those files — only what a filesystem pushed.
- **A filesystem's prefix is the consumer's to keep to one task at a time; its local directory is AgentForge's.** In one container, a task whose mount would share or nest another live task's local directory fails `FILESYSTEM_UNSYNCED`, retryable. Across containers AgentForge syncs what each task declares, and two tasks on one prefix at once overwrite each other file by file; a consumer's workflows prevent it — through `runtimeSessionId`, a continuity key, or a subpath per task.
- **`dangerouslyEnableDeletes` deletes what is missing locally, not only what the task removed.** Off by default; when on, the final push removes every object in the write scope with no local file, including any another writer added since the pull. It needs a remote path — `remoteRoot` joined with `subpath` — other than `/`; what a delete may reach is the procedure's to scope.
- **AgentForge gives an agent no filesystem permission.** The handler composes `context.agentOptions` (or its own rules and directories) into what it passes `runAgent`; Bash is not bounded by them, so a procedure lists the commands it allows.
- **A generated project fences reads to a run's working directories.** Its base options refuse a read outside them, even one an allow rule grants, through the file tools and read-only Bash, so a run that is not given its mounts cannot read them. The fence does not bound Bash that is not read-only, such as an interpreter a procedure allows: that would take a sandbox or a container per task. It does refuse a command the CLI cannot trace — inline code, `python -c` or `sh -c` — whatever the allow rules: ship the code as a file in the agent's layer and run that, or turn the fence off in the procedure's own options (`settings: { permissions: { blockReadsOutsideWorkingDirectories: false } }`, which `composeOptions` lets win).
- **Transcripts are kept 30 days by default** (`sessionRetention`, the project's, for all its agents), and hold everything the agent was sent and read.
- **Locally, sessions live in the container** and end with it; only a deployed agent persists them.

## Work in this repository

```bash
bunx nx run-many -t typecheck lint test
```

```bash
bunx nx run @beruangai/agentforge:integ --configuration=local
```

```bash
bunx nx run @beruangai/smoke-coverage:e2e
```

The e2e builds the image chain and serves the agent in Docker against a real model, with `CLAUDE_CODE_OAUTH_TOKEN` from `.env.serve.local`. `e2e-agentcore` deploys it with the operator's credentials from `.env.cdk` and runs the same path on AgentCore; `golden-kata` has both targets too.

## Read

| | |
|---|---|
| [docs/SOLUTION_SPACE.md](docs/SOLUTION_SPACE.md) | The problem, and what is in and out of scope |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works: layers, procedures, tasks, the container, the kernel, the package |
| [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) | What AgentForge answers to |
| [docs/DESIGN_OPTIONS.md](docs/DESIGN_OPTIONS.md) | What is not decided |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones |
| [adr/](adr/README.md) | Why the significant decisions went the way they did |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Terms |
| [docs/research/](docs/research/) | Dated, verified platform facts |
