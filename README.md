# AgentForge

Run a Claude Agent SDK procedure as an asynchronous, typed task — locally in Docker or on Bedrock AgentCore — and call it from anything, Temporal included.

Built for its consumers, StrategyFoundry and TrendBot, not for public use. **Status:** A1 delivered — the whole path runs locally against a real model on the [example agent](examples/hello-agent). A2 (AgentCore deploy) is next ([roadmap](docs/ROADMAP.md)).

## Define, implement, consume

**1. Define a contract** — what callers import. Plain oRPC and Zod; no Agent SDK.

```ts
// contract.ts
import { timeBudget } from '@beruangai/agentforge/contract';
import { oc } from '@orpc/contract';

export const helloAgent = {
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

const os = implementAgent(helloAgent);
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
runTaskProcess({ contract: helloAgent, router });
// server.ts — the container's entry; names the task entry, the rest from the environment
await startServer({ taskEntry: new URL('./task.ts', import.meta.url) });
```

**4. Consume it** — from any process, or as a Temporal activity.

```ts
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

[`examples/hello-agent`](examples/hello-agent) is all of this, complete, with its e2e.

## Known limits

Built to what the platforms document, with tests only where AgentForge relies on something they leave unsaid. Report what hits, and it is triaged in the layer that owns it.

- **Resume uses the session's working directory.** A transcript is keyed by the directory its session began in — the agent's own unless a procedure sets `cwd` — and a resume must run from the same one.
- **Files do not follow a session.** A resumed session remembers what earlier runs wrote, but a new container does not have those files — only what a working directory pushed.
- **A working directory's prefix is last-writer-wins.** Two tasks pushing one prefix at once overwrite each other file by file; serialise them with a continuity key, or give each its own prefix. `deletes` without `pull` empties the prefix of what the task did not write.
- **Working directories are verified by ETag**, so their buckets are S3-encrypted, and a file over 5 GB fails its push.
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
bunx nx run @beruangai/example-hello-agent:e2e
```

The e2e builds both images and runs the agent in Docker against a real model; it reads `CLAUDE_CODE_OAUTH_TOKEN` from `.env.integ.local`. `e2e-agentcore` deploys it and runs the same path on AgentCore.

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
