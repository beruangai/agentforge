# Consuming a procedure

Reference: the root [README](../../../../README.md#define-implement-consume) step 4, [ARCHITECTURE §3](../../../../docs/ARCHITECTURE.md#3-procedures) on the client and §4 on tasks, and [workflow projects](../../../../libs/agentforge/README.md#workflow-projects). Worked examples: `golden-kata`'s [e2e suite](../../../../packages/examples/golden-kata/e2e/golden-kata.suite.ts) and `golden-kata-workflows`' [workflow](../../../../packages/examples/golden-kata-workflows/workflows/write-and-grade.ts).

## The project client

Each agentic project generates one client over its agents, `@<scope>/<project>/client`, typed by their contracts. Build it the way the caller reaches the agents:

```ts
import { client as goldenKata } from '@beruangai/golden-kata/client';

const agents = goldenKata.local();                                     // local containers, found by name
const agents = await goldenKata.fromRuntimeConfig({ applicationId });  // AgentCore, from the deployment's runtime configuration
const agents = goldenKata.withTransports({ writer, grader });          // the caller's own transports
```

A caller outside the project that imports the client needs the project's `@<scope>/<project>-base/*` path mapping in its `tsconfig`. `Inputs['<agent>']['<Procedure>']` and `Outputs[…]` type a call's input and output.

## A call is a task

Invocation is asynchronous. Start a task, then poll it to an end:

```ts
const started = await agents.writer.Write.SendMessage(input, { runtimeSessionId, idempotencyKey });
const ended = await awaitTask(agents.writer.Write, started, { runtimeSessionId });
if (ended.state === 'TASK_STATE_COMPLETED') use(ended.output);          // typed by the contract
else if (ended.state === 'TASK_STATE_FAILED') handle(ended.cause);     // { code, retryable, retryAfter?, suggestedAction, … }
```

- **`runtimeSessionId`** routes to a container. Every call about one task (`SendMessage`, `GetTask`, `CancelTask`) carries the same one. Reuse it for work that should share a container.
- **`idempotencyKey`** identifies the execution. Sending the same key again attaches to a live or completed task, and starts the next attempt after any other end. Mint it once per logical execution (uuid7) and keep it for retries.
- **`continuityKey`** (optional) keeps two starts with the same key from running at once in a container.
- `GetTask(taskId, { runtimeSessionId })` reads once. `CancelTask(taskId, { runtimeSessionId })` sits at the client's root.
- A task view carries its ids, `attempt`, `image` (the image it was admitted in) and `runs` (each agent run's record: turns, cost, duration, session id).

**Failure causes** are in [ARCHITECTURE §4](../../../../docs/ARCHITECTURE.md#4-tasks). Retry exactly when `cause.retryable` is true, and no sooner than `retryAfter`. `LOST` means the container died and side effects may have happened. `TASK_STATE_REJECTED` is permanent: wrong procedure, contract mismatch, invalid input, or a start over 350 KB.

**A refused start** leaves no task. The container is stopping, full, or already running that continuity key, so the client throws `StartRefusedError` with when to retry. Wait and send it again.

## From a Temporal workflow

Generate a workflow project and connect it to each agentic project it calls:

```bash
nx g @beruangai/agentforge:workflow-project my-workflows
```

```bash
nx g @beruangai/agentforge:connection --project my-workflows --agenticProject golden-kata
```

In a workflow, resolve the agents and call a procedure like a function:

```ts
const agents = resolveAgents();                                     // from '../agents/workflow.ts'
const written = await agents.goldenKata.writer.Write(input, { runtimeSessionId: workflowInfo().workflowId });
const graded = await agents.goldenKata.grader.Grade({ kata: written.kata }, { runtimeSessionId }, { startToCloseTimeout: '3 hours' });
```

- Each call is an activity keyed by the workflow run and activity id, so every retry attaches to the same task. It heartbeats while it polls. It cancels the task only when the workflow asked for the cancel.
- Defaults: a one-minute heartbeat timeout, a day to close, and `WAIT_CANCELLATION_COMPLETED`. Set options for a set of calls with `resolveAgents(options)`, or per call with the third argument. Neither may set `activityId` or `taskQueue`.
- **Timeouts:** `startToCloseTimeout` must cover the procedure's time budget plus 15 minutes, since the activity waits out a refused start for up to 15 minutes. Leave `maximumAttempts`, `scheduleToCloseTimeout` and the workflow's timeouts unset, or wide enough for several attempts. Workflow code can't widen them once the activity is scheduled.
- Workflows import the agents' contracts as types only, so the workflow bundle carries none of their code. An output reaches the workflow as JSON: a `Date` arrives as a string.
- Test workflows with their activities stubbed, against the Temporal CLI's dev server (the project's `test` target), as [`write-and-grade.test.ts`](../../../../packages/examples/golden-kata-workflows/workflows/write-and-grade.test.ts) does.

The worker's environment (`TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, `AGENTFORGE_AGENTS`) is in the [package README](../../../../libs/agentforge/README.md#workflow-projects).
