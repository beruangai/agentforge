# AgentForge

Run a Claude Agent SDK procedure as an asynchronous, typed task — locally in Docker or on Bedrock AgentCore — and call it from anything, Temporal included.

Built for its consumers, StrategyFoundry and TrendBot, not for public use. **Status:** A1–A4 delivered — the whole path runs locally and on AgentCore, with filesystems, against a real model, specified and audited — and A5's baseline: the Nx plugin generates, syncs and deploys agentic projects, AgentForge's own [examples](packages/examples) among them ([roadmap](docs/ROADMAP.md)).

## Define, implement, consume

**1. Define a contract** — what callers import. Plain oRPC and Zod; no Agent SDK.

```ts
// contract.ts
import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';

export const contract = {
  summarise: oc
    .input(z.object({ text: z.string(), resumeSessionId: z.string().optional() }))
    .output(z.object({ summary: z.string(), words: z.number(), sessionId: z.string() })),
  sleepThenAnswer: oc.meta(timeBudget(300)).input(…).output(…),
};
```

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

// In a Temporal worker: start-or-attach keyed by the workflow run and activity, heartbeats, cancellation, retry guidance
export const summarise = procedureActivity(client.summarise, {
  runtimeSessionId: (input) => sessionFor(input),
  cancelTask: client.CancelTask,
});
```

A start the container cannot run now — stopping, full, or already running the start's continuity key — is **refused** with when to retry, leaving no task: the client throws `StartRefusedError`; the activity waits it out, up to 15 minutes per attempt, then fails retryable after the refusal's time. So give the activity a `startToCloseTimeout` covering the procedure's time budget plus those 15 minutes, and leave `maximumAttempts`, `scheduleToCloseTimeout` and the workflow's timeouts unset or wide enough for several attempts: workflow code cannot widen them once the activity is scheduled ([research](docs/research/temporal.md)).

The Nx plugin generates and maintains all of this (the [package README](libs/agentforge/README.md#the-nx-plugin)); [`packages/examples/smoke-coverage`](packages/examples/smoke-coverage) is this agent, generated, with its e2e.

## Known limits

Built to what the platforms document, with tests only where AgentForge relies on something they leave unsaid. Report what hits, and it is triaged in the layer that owns it.

- **Resume uses the session's working directory.** A transcript is keyed by the directory its session began in — the agent's own unless a procedure sets `cwd` — and a resume must run from the same one.
- **Files do not follow a session.** A resumed session remembers what earlier runs wrote, but a new container does not have those files — only what a filesystem pushed.
- **A filesystem's `localPath` and `remotePath` are the consumer's to keep to one task at a time.** AgentForge syncs what a task declares; two tasks on one path or prefix at once overwrite each other file by file. A consumer's workflows prevent it — through `runtimeSessionId`, a continuity key, or a `remotePath` per task.
- **`dangerouslyEnableDeletes` deletes what is missing locally, not only what the task removed.** Off by default; when on, the final push removes every object in the write scope with no local file, including any another writer added since the pull. It needs a non-empty `remotePath`; what a delete may reach is the procedure's to scope.
- **AgentForge gives an agent no filesystem permission.** The handler passes `context.filesystemPermissions` (or its own rules) to `runAgent`; Bash is not bounded by them, so a procedure lists the commands it allows.
- **Transcripts are kept 30 days by default** (`sessionRetention`), and hold everything the agent was sent and read.
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
