# Design

Guidance, not prescription: adapt to actual constraints. The decisions are recorded in [ADR 0016](../../../adr/0016-a-workflow-project-is-a-generated-caller.md) (proposed) — a workflow project and its connections, the type-only workflow side, Node, ECS on Temporal Cloud, the dev server locally, cancelling only on a requested cancel — and are not argued again here. The platform facts are in [`research/temporal.md`](../../../docs/research/temporal.md), read 2026-09-30.

## Context

- `/temporal` exports `procedureActivity(procedure, { runtimeSessionId(input), start?(input), cancelTask, pollIntervalMilliseconds? })`, returning `(input) => Promise<Output>`. Its idempotency key is `<workflowId>/<runId>/<activityId>`. On any abort of its cancellation signal it calls `cancelTask` ([activity.ts](../../../libs/agentforge/src/client/temporal/activity.ts)). Its only live coverage is smoke-coverage's `temporal-activity` e2e, in `MockActivityEnvironment`, without a worker.
- **Generated seams use generic names, and the importer aliases them** (the refactor landing before this change): an agent's `contract.ts` exports `contract`; an agentic project's `client.ts` exports `client` — `local()`, `fromRuntimeConfig({ applicationId })`, `withTransports` — `Client`, `Agent`, `CONTRACTS`, `RUNTIME_CONFIG_KEYS` and `CONTAINER_NAMES`; its constructs are `project.ts` (`AgenticProject`, `AgenticProjectProps`) and `agents/<agent>/agent.ts` (`Agent`, `AgentProps`, `Secrets`), and the project's `index.ts` in the shared constructs aliases them to the project's names (`GoldenKata`, `GoldenKataWriter`) for the barrel. The client's agents are typed per agent as `AgentForgeClient<Contract>` — nested namespaces, `PascalCase` leaf procedures, `CancelTask` at each agent's root.
- The plugin's record is `metadata.generator` plus `metadata.components[]` in `@aws/nx-plugin`'s form, and `agentforge.detached`; sync renders every maintained artifact from it ([project-record.ts](../../../libs/agentforge/src/plugin/project-record.ts)). Constructs are generated into `packages/common/constructs/src/app/agentic-projects/<project>/`, typed from the layers' `secrets.ts`.
- `@temporalio/*` 1.24.0 is in the catalog. `@temporalio/envconfig` 1.24.0 exposes `loadClientConnectConfig({ disableFile, overrideEnvVars, … })`. On Node 26.8.2 the core bridge loads and `TestWorkflowEnvironment.createLocal()` starts the brew CLI (observed 2026-09-30).
- `.env` sets `TEMPORAL_NAMESPACE=beruangai-agentforge.vwhld`, and Nx loads it into every task: the local server and Temporal Cloud share the namespace's name.
- In this repository the plugin runs from source and the Nx daemon keeps it loaded: after changing a renderer, `nx sync` reports no drift until `nx reset` (or `NX_DAEMON=false`). Verify sync with the daemon off.

## Goals / Non-Goals

**Goals:** a workflow project generated, synced and detachable like an agentic project; connections from which everything spanning agentic projects is rendered; typed calls from workflows; a worker whose redeploy never stops an agent's run; one construct for the worker on ECS; `golden-kata-workflows` verified locally, hybrid, and on ECS against Temporal Cloud.

**Non-goals:** see proposal. Also: no `image` target for the worker — locally the worker runs as a Node process, and its image is built by CDK from the bundle's build context at deploy.

## Public API

```ts
// @beruangai/agentforge/temporal
/** What a workflow passes with each call: a start's fields but the idempotency key, which the activity derives. */
export type ActivityStart = Omit<Starting, 'idempotencyKey'>;

export interface ProcedureActivityOptions {
  readonly cancelTask: (taskId: string, context: Routed) => Promise<unknown>;
  readonly pollIntervalMilliseconds?: number;
}
export function procedureActivity<Input, Output>(
  procedure: ProcedureClient<Input, Output>,
  options: ProcedureActivityOptions,
): (input: Input, start: ActivityStart) => Promise<Output>;

/**
 * Every procedure of every agent of an agentic project, as activities named
 * `<project>.<agent>.<namespace…>.<Procedure>` — `goldenKata.writer.Write`.
 * Walks the contracts (oRPC's procedure check), not the client.
 */
export function projectActivities<Contracts extends Readonly<Record<string, RouterContract>>>(
  project: string,
  contracts: Contracts,
  client: { readonly [Agent in keyof Contracts]: AgentForgeClient<Contracts[Agent]> },
  options?: { readonly pollIntervalMilliseconds?: number },
): Readonly<Record<string, (input: never, start: ActivityStart) => Promise<unknown>>>;

/** How the worker reaches agents: AGENTFORGE_AGENTS = `local` | `runtime-config:<applicationId>`. */
export type AgentsSetting =
  | { readonly kind: 'local' }
  | { readonly kind: 'runtime-config'; readonly applicationId: string };
export function agentsFromEnvironment(environment?: NodeJS.ProcessEnv): AgentsSetting;

/** envconfig from the environment only (`disableFile: true`); address and namespace required; a key never with a local address. */
export function temporalConnectConfig(environment?: NodeJS.ProcessEnv): {
  readonly connectionOptions: NativeConnectionOptions;
  readonly namespace: string;
};
/** A client for starting workflows, over `Connection` (Node). */
export function connectTemporalClient(environment?: NodeJS.ProcessEnv): Promise<Client>;

export interface RunWorkerOptions {
  readonly taskQueue: string;
  /** The `bundle-workflows` output, beside the worker bundle. */
  readonly workflowBundle: URL;
  /** The consumer's own activities. */
  readonly activities: Readonly<Record<string, (...args: never[]) => Promise<unknown>>>;
  /** Every connected project's `projectActivities`. */
  readonly agentActivities: Readonly<Record<string, (...args: never[]) => Promise<unknown>>>;
  /** The project's `REQUIRED_SECRETS`. */
  readonly requiredSecrets: readonly string[];
  /** Default '110s', inside ECS's 120 s stop timeout. */
  readonly shutdownGraceTime?: Duration;
}
/** Checks the environment, connects a NativeConnection, creates the Worker and runs it until a shutdown signal. */
export function runWorker(options: RunWorkerOptions): Promise<void>;
```

```ts
// @beruangai/agentforge/temporal/workflow — imports only @temporalio/workflow at run time
export type ActivityStart = /* re-exported as a type */;

/** A contract's procedures as workflow calls. */
export type WorkflowCalls<Contract> =
  Contract extends ProcedureContract<infer Input, infer Output, infer _Errors>
    ? (input: InferSchemaInput<Input>, start: ActivityStart) => Promise<InferSchemaOutput<Output>>
    : { readonly [Key in keyof Contract]: WorkflowCalls<Contract[Key]> };

/** Merged under the caller's options. */
export const DEFAULT_ACTIVITY_OPTIONS: ActivityOptions; // { heartbeatTimeout: '1 minute', startToCloseTimeout: '1 day' }

/** Nested proxies whose leaf call is `proxyActivities(options)['<project>.<agent>.….<Procedure>']`. */
export function proxyProject<Contracts extends Readonly<Record<string, RouterContract>>>(
  project: string,
  options?: ActivityOptions,
): { readonly [Agent in keyof Contracts]: WorkflowCalls<Contracts[Agent]> };
```

```ts
// @beruangai/agentforge/infra — addition
export type WorkerSecrets<Declared extends string> =
  { readonly TEMPORAL_API_KEY: ISecret } & { readonly [Name in Declared]: ISecret };

export interface TemporalWorkerProps {
  readonly cluster: ICluster;
  /** The worker's image build context: the project's `bundle` output. */
  readonly directory: string;
  readonly temporal: { readonly address: string; readonly namespace: string };
  readonly secrets: WorkerSecrets<string>;
  /** Set by the generated construct: `runtime-config:<applicationId>`. */
  readonly agents: string;
  readonly environment?: Readonly<Record<string, string>>;  // refused: TEMPORAL_*, AGENTFORGE_AGENTS, any declared secret
  readonly cpu?: number;             // default 256
  readonly memoryLimitMiB?: number;  // default 512
  readonly desiredCount?: number;    // default 1
  readonly vpcSubnets?: SubnetSelection;
  readonly securityGroups?: readonly ISecurityGroup[];
  readonly assignPublicIp?: boolean;
  readonly logRetention?: RetentionDays;   // default THREE_MONTHS
  readonly removalPolicy?: RemovalPolicy;  // the log group; default RETAIN
}
export class TemporalWorker extends Construct implements IGrantable {
  readonly service: FargateService;
  readonly grantPrincipal: IPrincipal;  // the task role
  constructor(scope: Construct, id: string, props: TemporalWorkerProps);
}
```

Generated, for `golden-kata-workflows`:

```jsonc
// project.json metadata
"metadata": {
  "generator": "@beruangai/agentforge:workflow-project",
  "components": [
    { "generator": "@beruangai/agentforge:connection", "name": "golden-kata",
      "path": "../golden-kata", "packageName": "@beruangai/golden-kata", "key": "goldenKata" }
  ],
  "agentforge": { "detached": { "files": [], "targets": [] } }
}
```

```ts
// client.ts (maintained) — exported as @beruangai/golden-kata-workflows/client
export const TASK_QUEUE = 'beruangai-golden-kata-workflows';
export const connectClient = (): Promise<Client> => connectTemporalClient();

// agents/activities.ts (maintained) — the worker side, one entry per connection
import {
  CONTRACTS as GOLDEN_KATA_CONTRACTS,
  client as goldenKataClient,
} from '@beruangai/golden-kata/client';
export async function agentActivities() {
  const agents = agentsFromEnvironment();
  const goldenKata = agents.kind === 'local' ? goldenKataClient.local() : await goldenKataClient.fromRuntimeConfig(agents);
  return { ...projectActivities('goldenKata', GOLDEN_KATA_CONTRACTS, goldenKata) };
}

// agents/workflow.ts (maintained) — the workflow side; contracts imported as types only
import type { CONTRACTS as GOLDEN_KATA_CONTRACTS } from '@beruangai/golden-kata/client';
export const agents = (options?: ActivityOptions) => ({
  goldenKata: proxyProject<typeof GOLDEN_KATA_CONTRACTS>('goldenKata', options),
});

// packages/common/constructs/src/app/workflow-projects/golden-kata-workflows/project.ts (maintained)
import { AgenticProject as GoldenKata } from '../../agentic-projects/golden-kata/project.js';
export type Secrets = WorkerSecrets<(typeof PROJECT_SECRETS)[number]>;
export type WorkflowProjectProps =
  Omit<TemporalWorkerProps, 'directory' | 'secrets' | 'agents'> & {
    readonly secrets: Secrets;
    readonly agenticProjects: { readonly goldenKata: GoldenKata };
  };
export class WorkflowProject extends TemporalWorker { /* grantInvoke on each project; agents = runtime-config:<RuntimeConfig app id> */ }

// packages/common/constructs/src/app/workflow-projects/golden-kata-workflows/index.ts (maintained) — the barrel's names
export {
  WorkflowProject as GoldenKataWorkflows,
  type WorkflowProjectProps as GoldenKataWorkflowsProps,
  type Secrets as GoldenKataWorkflowsSecrets,
} from './project.js';
// packages/common/constructs/src/app/workflow-projects/index.ts and app/index.ts: `export *` lines, maintained
```

A workflow, as the example writes it:

```ts
const { goldenKata } = agents();
export async function writeAndGrade(input: WriteInput): Promise<WrittenAndGraded> {
  const runtimeSessionId = workflowInfo().workflowId;
  const written = await goldenKata.writer.Write(input, { runtimeSessionId });
  const grade = await goldenKata.grader.Grade({ kata: written.kata }, { runtimeSessionId });
  return { written, grade };
}
```

## Decisions

### A connection is a component of the workflow project

The record lives on the workflow project, not the agentic one: the caller knows what it calls, and an agentic project serves callers it need not know (ADR 0001's direction, one level up). `name` is the agentic project's own name, `key` its camelCase used in activity names and in `agents.<key>`, `packageName` what the rendered imports use, `path` for display only — rendering resolves the agentic project from the Nx graph by `packageName`, failing the sync, naming it, when it is gone. `connection` takes `--project` (the workflow project) and `--agenticProject`; it refuses either of the wrong kind before writing.

What a connection renders: the host `package.json`'s dependency on the agentic project (`workspace:*`) and its base layer's `paths` in `tsconfig.lib.json` (the ROADMAP's note that a caller importing the client needs the mapping); one entry in `agents/activities.ts` and `agents/workflow.ts`; one required prop and one `grantInvoke` in the project's construct.

### Generated layout, and who owns each artifact

| Artifact | Ownership |
|---|---|
| `project.json` targets and `metadata.generator` | maintained; components appended by generators |
| `package.json` keys: dependencies (AgentForge, `@temporalio/*`, each connection), `exports["./client"]` | maintained keys |
| `tsconfig.json`, `tsconfig.lib.json` keys: each connection's `paths` | maintained keys |
| `worker.ts` | maintained |
| `client.ts` | maintained |
| `agents/activities.ts`, `agents/workflow.ts` | maintained |
| `container/Dockerfile`, `container/package.json` (the image's runtime dependencies), `container/bun.lock` (written by `lock`) | maintained |
| the construct in the shared constructs | maintained |
| `workflows/index.ts` (the bundle's entry), `workflows/example.ts`, `workflows/example.test.ts` | scaffolded |
| `activities/index.ts` (the consumer's own activities, a placeholder) | scaffolded |
| `secrets.ts` (`REQUIRED_SECRETS = []`) | scaffolded |

The placeholder workflow calls the placeholder activity only, since a new project has no connections; its test runs it with `TestWorkflowEnvironment.createLocal({ server: { executable: { type: 'existing-path', path: <temporal on PATH> } } })` and `Worker.create({ workflowsPath })`, the activity stubbed. `worker.ts` is `runWorker({ taskQueue: TASK_QUEUE, workflowBundle: new URL('./workflows.js', import.meta.url), activities, agentActivities: await agentActivities(), requiredSecrets: REQUIRED_SECRETS })`.

### Targets

| Target | Does | Depends on |
|---|---|---|
| `bundle-workflows` | `bundleWorkflowCode` on `workflows/index.ts` → `dist/{projectRoot}/bundle/workflows.js`; cached, inputs its sources and the installed `@temporalio/worker` version | — |
| `lock` | The worker image's lock: `container/package.json` (the `@temporalio/*` packages at the versions the workspace installed, rendered by sync) locked seeded with the workspace's lock, so every version it pinned stays pinned | `^bundle` |
| `bundle` | `bun build worker.ts --target=node --format=esm --external '@temporalio/*'` → `dist/{projectRoot}/bundle/worker.mjs`, with `container/Dockerfile`, `package.json` and `bun.lock` copied beside it: the image's whole build context | `bundle-workflows`, `lock`, `^bundle` |
| `assemble` | For the shared constructs' `assemble`, so `synth` finds the context | `bundle` |
| `temporal-server` | Continuous: `temporal server start-dev --db-filename dist/{projectRoot}/temporal-server/temporal.db --namespace $TEMPORAL_NAMESPACE` (UI on 8233) | — |
| `serve` | Continuous: `node dist/{projectRoot}/bundle/worker.mjs`, `TEMPORAL_ADDRESS=localhost:7233`; configuration `local` sets `AGENTFORGE_AGENTS=local` and loads `.env.serve.local` (the project's secrets); `hybrid` loads `.env.hybrid.local` (`AGENTFORGE_AGENTS=runtime-config:<id>`, `AWS_PROFILE`, the project's secrets) | `bundle`, `temporal-server` |

Every `@temporalio/*` package is external to the worker bundle: the core bridge is native, and `@temporalio/activity`'s context must be the one copy the worker installs, or `activityInfo()` finds no activity. The worker bundle resolves with the workspace's `customConditions`, so this repository's source condition applies without a target naming it — to be confirmed for `bun build` on the first task; if it does not, the executor passes the tsconfig's conditions, never a hard-coded one. `bundle-workflows` and `bundle` are executors (`@beruangai/agentforge:bundle-workflows`, `:bundle-worker`), so their behaviour is AgentForge's and unit-tested; `temporal-server` and `serve` are `nx:run-commands`.

The image (`container/Dockerfile`): a Bun stage, pinned by digest, installs `package.json` frozen from `bun.lock` with `--production`; the final stage is `node:26-slim` (glibc; musl is unsupported), pinned by digest, with that `node_modules`, `worker.mjs` and `workflows.js`, running as `node`, `CMD ["node", "worker.mjs"]`. ARM64.

### The connection comes from the environment, checked

`temporalConnectConfig` calls `loadClientConnectConfig({ disableFile: true })` — no profile file can change a worker's connection silently — and then refuses, naming each: an unset `TEMPORAL_ADDRESS` or `TEMPORAL_NAMESPACE` (envconfig checks neither), and `TEMPORAL_API_KEY` with an address whose host is `localhost`, `127.0.0.1`, `::1` or `host.docker.internal`. TLS follows the key, as the SDK does. `runWorker` also refuses an unset secret of `requiredSecrets`, and an activity name in both `activities` and `agentActivities`. `TEMPORAL_API_KEY` is not required at start: locally there is none; deployed, the construct requires it at compile time, and Temporal Cloud refuses a connection without one.

### Cancelling only on a requested cancel

In the activity's catch, `cancellationDetails()?.cancelRequested === true` cancels the task and throws `CancelledFailure`; any other abort rethrows the `CancelledFailure` without touching the task. The worker then reports the attempt failed (so Temporal retries it sooner than the heartbeat timeout), or cannot report it, and the heartbeat timeout does. Either way the next attempt's `SendMessage` carries the same idempotency key and attaches (ADR 0009). `cancelRequested`, not `workerShutdown`, is the test: the SDK's own shutdown path may pass no details. The refusal wait keeps ending at once on any abort — no task exists yet.

### The worker's construct

`TemporalWorker` creates the task definition (Fargate, `LINUX`/`ARM64`), a container from `ContainerImage.fromAsset(directory)` with `stopTimeout: 120s`, the environment `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `AGENTFORGE_AGENTS`, each secret through ECS secrets (read by the execution role only), awslogs to a log group of its own, and a `FargateService` with the deployment circuit breaker and rollback on, `minHealthyPercent: 100`, no load balancer and a security group with no ingress. Its checks at synth: a secret also in `environment`, an owned key in `environment`, or a missing `directory` throw, naming them. Where it chooses against a checkov rule it records why on the resource, as `AgentRuntime` does.

The generated construct renders `agenticProjects` from the connections — a missing one is a type error — calls each `grantInvoke(this)` (invocation of exactly that project's agents and read of the runtime configuration), sets `agents` to `runtime-config:<RuntimeConfig.ensure(this).appConfigApplicationId>`, and points `directory` at `dist/<projectRoot>/bundle`, throwing at synth, naming `nx run <project>:bundle`, when `worker.mjs` is absent.

### The workflow side

`proxyProject` builds one `proxyActivities({ ...DEFAULT_ACTIVITY_OPTIONS, ...options })` and returns nested proxies that accumulate the path and call `activities[path](input, start)` at the leaf. `heartbeatTimeout` of a minute sits above the activity's 5 s poll heartbeat with room for a slow `GetTask`; `startToCloseTimeout` of a day is only a backstop, since the agent's time budget bounds the task and a longer attempt merely attaches again. Retries follow Temporal's default policy; `procedureActivity` makes non-retryable causes non-retryable. The type imports are erased by swc in `bundleWorkflowCode`, so the bundle holds none of the contracts; a runtime import of a contract there would pull its modules into the sandbox and is the mistake to avoid — the maintained file makes it once, correctly.

### `golden-kata-workflows`

Generated by `workflow-project` and `connection --agenticProject @beruangai/golden-kata`; `writeAndGrade` written by hand; the placeholder workflow and test replaced by its own. Its infra is `golden-kata-infra`'s: the application stack gains a VPC (two AZs, public subnets only, no NAT gateway), a cluster, and `GoldenKataWorkflows` with `assignPublicIp: true`, `temporal: { address: 'beruangai-agentforge.vwhld.tmprl.cloud:7233', namespace: 'beruangai-agentforge.vwhld' }`, and the key from `Secret.fromSecretNameV2(this, …, 'agentforge/temporal-api-key')`. The secret is the operator's, created outside any stack like `agentforge/claude-code-oauth-token`, so the worker never starts without its value and `destroy` leaves it. The `Caller` role and its output are removed; the stack test asserts the worker's grants instead.

Its e2e, one vitest config with a project per place, one shared suite: start `writeAndGrade` through `connectClient()`, await the result, and assert what holds whichever way the model chooses — each output parses, the grade scores every rubric criterion, the grader graded the kata the writer wrote.

| Target | Temporal | Worker | Agents | Credentials |
|---|---|---|---|---|
| `e2e` | `temporal-server` | `serve:local` | `golden-kata:serve-writer`, `serve-grader` | `.env.serve.local` |
| `e2e-hybrid` | `temporal-server` | spawned by the suite's global setup from the `bundle` output, `AGENTFORGE_AGENTS=runtime-config:<id>` read from `golden-kata-infra`'s deploy outputs | `golden-kata-infra:deploy` | `.env.integ` (the test role) |
| `e2e-agentcore` | Temporal Cloud, `TEMPORAL_ADDRESS` in the target's env | on ECS, from `golden-kata-infra:deploy` | same deploy | `.env.integ`, `TEMPORAL_API_KEY` from `.env.integ.local` |

Each waits for a poller on the task queue (`DescribeTaskQueue`) before starting, since Nx starts a continuous task's dependents once it started, not once it serves.

## Error handling

| Failure | Outcome |
|---|---|
| `TEMPORAL_ADDRESS` or `TEMPORAL_NAMESPACE` unset; a declared secret unset; an API key with a local address; `AGENTFORGE_AGENTS` unset or malformed | The worker throws at start, naming each; the process exits non-zero. Deployed, the circuit breaker fails the deploy |
| Workflow bundle missing | `runWorker` throws, naming `nx run <project>:bundle-workflows` |
| An activity name in both the consumer's and the agents' activities | `runWorker` throws, naming it |
| Temporal Cloud refuses the key | `NativeConnection.connect` throws; the worker exits; deployed, the deploy fails |
| A connection's agentic project gone from the graph | Sync fails, naming the record |
| `connection` from a non-workflow project, or to a non-agentic project | The generator throws before writing |
| A worker shutdown, heartbeat timeout, pause or reset mid-task | The activity rethrows `CancelledFailure`, the task keeps running, the next attempt attaches |
| A requested cancel mid-task | `CancelTask`, then `CancelledFailure` |
| A failed task | `ApplicationFailure` with the cause's code, retryable as the cause is, `nextRetryDelay` from `retryAfter` (unchanged) |
| The construct given an owned environment key, or a secret also as a plain value | Throws at synth, naming it |
| The construct synthesised before `bundle` | Throws at synth, naming the target |
| A connected project's construct not given | Type error in the consumer's infrastructure |

## Testing

- **`test` (libs)**: `procedureActivity` in `MockActivityEnvironment` — `cancel('CANCELLED', { cancelRequested: true })` cancels the task; `cancel('WORKER_SHUTDOWN')`, a heartbeat-timeout cancel and one with no details do not; the start fields come from the call. `projectActivities` names nested procedures and routes each to its client. `temporalConnectConfig`'s refusals, with no file read. `agentsFromEnvironment`. `proxyProject`'s paths, and a type test that a wrong procedure or input fails. The generators and sync by snapshot; `TemporalWorker` and a generated construct on a synthesised template — the grants, the refusals, `stopTimeout` above the grace.
- **`test` (a workflow project)**: its workflows against the dev server, the CLI on `PATH`; `temporal --version` is a runtime input. `golden-kata-workflows`' unit test runs `writeAndGrade` with the agents' activities stubbed.
- **`integ` local, `integ/local/temporal-worker/`** — earns its place because the design relies on it and the SDK documents it thinly: a real `Worker` against the dev server over a scripted `ProcedureClient`; the worker shut down mid-activity, a second worker taking the retry: `CancelTask` never called, the retry's `SendMessage` carrying the same idempotency key; and a workflow's cancel reaching `CancelTask`. Also that `runWorker` exits on `SIGTERM` within its grace.
- **`e2e`**: the three places above.
- **Settled once, not tested**: the dev server's flags and UI, envconfig's variable names, TLS following the key, the namespace endpoint's format, Fargate's 120 s stop ceiling — the research note.

## Risks / Trade-offs

- **Node 26 is outside the SDK's tested range.** Loaded and ran on 2026-09-30; a workflow project's `test` and `integ` local run it on every build. A failure is raised with the operator, not worked around by pinning another Node silently.
- **A contract output that does not survive JSON** — a `Date`, a transformed value — reaches a workflow as Temporal's payload converter decodes it, not as the type says. The wire is JSON already, so a contract that round-trips over A2A round-trips here; the README says so.
- **A terminated or reset workflow leaves its task running** to its time budget (ADR 0016).
- **`bun build` resolution** of the workspace's conditions and paths is assumed, and confirmed by the first bundling task.
- **One worker, fixed count**: a heavy consumer raises `desiredCount` and the size; autoscaling on schedule-to-start latency comes when a consumer's load needs it.

## Migration Plan

No consumer depends on `/temporal`. smoke-coverage's `temporal-activity` test moves to `(input, start)` with the signature (task 2.1). `.env.hybrid.local.example` is removed; `.env.hybrid.local` holds `AGENTFORGE_AGENTS` and `AWS_PROFILE`, and no `TEMPORAL_API_KEY`.
