# Design

## Context

See proposal.md — Why. What holds today:

- **`AgentRuntime`** (`src/infra/agent-runtime.ts`) provisions, per agent:
  - the L2 `Runtime`;
  - a `TaskTable` (key `pk`, TTL, PITR, pay per request);
  - a `SessionBucket` (private, versioned, its lifecycle set by `sessionRetention`, `CKV_AWS_18` suppressed with its reason);
  - a `Dashboard` from `operationalDashboard`, AgentForge's counts by dimension `AgentRuntimeName` beside AgentCore's;
  - a `ReadinessProbe` Lambda with its log group, and a `Custom::AgentForgeReadiness` resource.

  It owns the environment variables `AGENTFORGE_TABLE_NAME`, `AGENTFORGE_SESSION_BUCKET`, `AGENTFORGE_METRICS_RUNTIME_NAME`, `AGENTFORGE_SECRETS`, `AGENTFORGE_TELEMETRY` and `AGENTFORGE_FILESYSTEM_BUCKETS`, refusing each in `environmentVariables`, and exposes `taskTable`, `sessionBucket` and `dashboard`.
- **The task store** (`server/runtime/task-store.ts`, `DynamoDBTaskStore(client, tableName, metrics)`) keys items by `pk`:
  - `task#<id>`, `input#<id>` and `output#<id>` for a task;
  - `key#<idempotencyKey>` for the binding of a key to its task.

  `save` writes the task record with an Update; `load` derives `LOST` from a lapsed lease with a full Put of the record. `cancelTask` (`server/runtime/gateway.ts`) stops the task only if it runs in this container, and otherwise answers with the stored task.
- **The S3 session store** (`server/harness/session-store.ts`, `S3SessionStore({ bucket, client })`) keys parts as `{projectKey}/{sessionId}[/{subpath}]/part-…jsonl`. Every agent's `projectKey` is the same, since every run's cwd is `/workspace/agentic/agent`; session ids are uuids. `sessionStoreFromEnvironment` builds it in each task process, at its start, from `AGENTFORGE_SESSION_BUCKET`.
- **The agent's name:**
  - It is `ENV AGENTFORGE_AGENT_NAME` in the agent's generated Dockerfile.
  - The server's config takes it from `startServer`'s `agentName` or that variable, required (`server/runtime/server.ts`), and uses it for the agent card and telemetry.
  - Task processes are spawned with the server's `process.env` (`executor.ts`), which carries it only when it came from the environment.
  - The plugin validates agent names with `KebabNameField` (`plugin/names.ts`, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`).
- **The generated constructs** (`plugin/artifacts/constructs.ts`, regenerated into `packages/common/constructs`):
  - The project construct (`AgenticProject`) creates each agent's construct from `props.agents.<agent>`.
  - Each agent's construct (`Agent extends AgentRuntime`, `AgentProps = Omit<AgentRuntimeProps, 'agentRuntimeArtifact' | 'secrets'> & { secrets }`) supplies the artifact and registers the runtime configuration.
- **The examples' stacks** pass `removalPolicy` per agent and output each agent's session bucket (`WriterSessionBucketName`, `GraderSessionBucketName`, `HelloAgentSessionBucketName`). Their `destroy` empties those buckets first (`scripts/empty-buckets.ts`), and `smoke-coverage`'s AgentCore suite lists transcripts in its bucket.
- **The integration fixture** `integ/aws/agentcore/__fixtures__/agentforge-runtime-app.ts` deploys one `AgentRuntime` directly.
- **The records that say "per agent":** ADR 0006 (one table, its items) and ADR 0011 (a bucket each agent's construct owns, needing no namespace); ARCHITECTURE §2 (`sessionId`), §7 (deploying), §8 (`/infra`); GLOSSARY "Session store".

## Goals / Non-Goals

**Goals:**
- One task table, session bucket, dashboard and readiness Lambda per project.
- An agent's tasks, key bindings and transcripts are its own within them, by key layout and by agent name, not by IAM partitioning of the table.
- The generated constructs carry it, so a consumer writes nothing new.

**Non-Goals:** as in proposal.md.

## Decisions

### `AgenticProjectResources` owns what a project's agents share

```ts
// src/infra/agentic-project-resources.ts, exported from /infra
export interface AgenticProjectResourcesProps {
  /** Titles the dashboard. */
  readonly projectName: string;
  /**
   * What happens to the task table and the session bucket when the stack
   * deletes them. `DESTROY` deletes the bucket only when it is empty.
   * @default RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: RemovalPolicy;
  /**
   * How long a transcript is kept after it is written (§REQ402), for every agent.
   * @default Duration.days(30)
   */
  readonly sessionRetention?: Duration;
}

/**
 * What an agentic project's agents share: the table their tasks live in, the
 * bucket their transcripts persist in (an agent's under its own name), one
 * dashboard with a section per agent, and one readiness probe that holds a
 * deploy until each agent serves.
 */
export class AgenticProjectResources extends Construct {
  readonly taskTable: Table;
  readonly sessionBucket: Bucket;
  readonly dashboard: Dashboard;
  constructor(scope: Construct, id: string, props: AgenticProjectResourcesProps);
  /**
   * Called by `AgentRuntime`: adds the agent's dashboard section, titled by its
   * name, and its readiness check, granting the probe the runtime. Refuses a
   * name already added.
   */
  addAgent(agent: { readonly agentName: string; readonly runtime: Runtime; readonly scope: Construct }): void;
}
```

- The table, bucket and probe keep today's settings, moved unchanged, the bucket's `CKV_AWS_18` suppression and its reason with it: the bucket is still AgentForge's alone, now for one project's agents.
- `operationalDashboard` becomes a section builder: a text header naming the agent, then its widgets, appended to the one dashboard.
- Each agent's readiness `CustomResource` stays in the agent's own scope, so removing an agent removes its check. Its `serviceToken` is the project's probe, which already reads the ARN and version from the resource's properties.
- `addAgent` is public only because `AgentRuntime` is another class. It is documented as `AgentRuntime`'s and refuses a duplicate name, so two agents can never share a key scope.
- `AgentRuntime.image`, which `task-image` adds, is unaffected: an agent's image is its own.

*Alternatives:*
- **A project construct inside the plugin's generated code alone.** The shared resources' settings and grants are AgentForge's to keep correct, and the integration fixture deploys without the plugin, so the construct belongs in `/infra`.
- **Share only the dashboard and the probe**, keeping a table and a bucket per agent. It would leave the store and the session store unchanged, but the operator chose all four per project (2026-10-08): one table and one bucket are one place to look, and the per-agent split bought no isolation the agent field does not.

### `AgentRuntime` takes `project` and `agentName`

```ts
export interface AgentRuntimeProps
  extends Omit<RuntimeProps, 'protocolConfiguration' | 'authorizerConfiguration'> {
  /** The project's shared resources, which this agent's tasks and transcripts live in. */
  readonly project: AgenticProjectResources;
  /** The agent's name within its project, as its image names it; matches AGENT_NAME_PATTERN. */
  readonly agentName: string;
  readonly tracingEnabled?: boolean;
  readonly secrets: AgentSecrets & Readonly<Record<string, AgentSecret>>;
  readonly telemetry?: TelemetryLevel;
  readonly filesystems?: Readonly<Record<string, S3FilesystemBucket>>;
}
export class AgentRuntime extends Construct {
  readonly runtime: Runtime;
  get agentRuntimeArn(): string;
  grantInvoke(grantee: IGrantable): Grant;
}
```

- **The name's pattern** is `AGENT_NAME_PATTERN` in `core/agent-name.ts`, `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`; the plugin's `KebabNameField` is built from it, so a name the plugin generates is one the construct takes.
- **The variable it owns:** `AGENTFORGE_AGENT_NAME` joins them. The construct sets it from `agentName`, overriding the image's `ENV`, so a deployed agent is named by exactly what its grants are scoped to; setting it in `environmentVariables` is refused.
- **Its grants:**
  - `taskTable.grantReadWriteData(runtime)`, as today;
  - read and write of `sessionBucket` objects under `<agentName>/*`;
  - `s3:ListBucket` conditioned on `s3:prefix` `<agentName>/*`.

### The agent's name reaches both stores from the server's config

The server's config stays the one source of the name, wherever it came from:
- `server.ts` constructs the store as `new DynamoDBTaskStore(client, config.tableName, config.agentName, metrics)`;
- the executor takes `agentName` in its `ExecutorConfig` and spawns each task process with `AGENTFORGE_AGENT_NAME` set from it, so a name given to `startServer` reaches the session store as well as one from the environment.

### The task store scopes by agent, keyed by task id

`DynamoDBTaskStore` takes the agent's name:
- **Every write of a task record** sets `agent`: `save`'s Update, and the Put that records a derived `LOST`, which replaces the whole item. The `pk` is unchanged (`task#<id>`, `input#<id>`, `output#<id>`).
- **Reading a task** (`readTask`, under `load`, `GetTask` and `cancelTask`'s answer in the gateway):
  - a record without `agent` throws, as a record without its state does;
  - a record whose `agent` differs is absent. The caller sees A2A's task-not-found, and the record is never written, not even to derive `LOST`.
- **A key binds per agent**, as `key#<agent>#<idempotencyKey>`.

Local serving is unchanged: each agent has its own DynamoDB Local, and the same code path scopes it identically (§REQ701).

*Alternative:* `pk` as `<agent>#task#<id>`. That splits the key the operator wants to stay the task's uuid, for no isolation the agent field does not give.

### Transcripts are stored under the agent's name

```ts
new S3SessionStore({ bucket, prefix, client });   // prefix: the agent's name
```

`sessionStoreFromEnvironment` passes `AGENTFORGE_AGENT_NAME` as the prefix. A bucket named without an agent name throws, rather than writing unprefixed. Keys become `<agent>/{projectKey}/{sessionId}[/{subpath}]/part-…jsonl`. A resume therefore loads only the agent's own sessions, and the grant makes another agent's unreachable as well.

### The generated constructs

- **The project construct** creates `this.resources = new AgenticProjectResources(this, 'Resources', { projectName, removalPolicy, sessionRetention })`. It takes `removalPolicy` and `sessionRetention` at the top of `AgenticProjectProps`, each agent's options as `Omit<…Props, 'project'>`, and passes `{ ...props.agents.<agent>, project: this.resources }` to each agent.
- **Each agent's construct** keeps `constructor(scope: Construct, id: string, props: AgentProps)`, with `AgentProps = Omit<AgentRuntimeProps, 'agentRuntimeArtifact' | 'secrets' | 'agentName'> & { secrets }`. It passes `agentName: '<agent>'` from its component record, the same record its Dockerfile's `ENV` is rendered from.

The construct ids `TaskTable`, `SessionBucket` and `Dashboard` leave each agent's scope, so a deployed stack replaces them.

### The examples

- Each stack sets `removalPolicy` once on the project and outputs one `SessionBucketName`.
- Each `scripts/empty-buckets.ts` empties `SessionBucketName`, and each infrastructure README says so.
- `smoke-coverage`'s AgentCore suite lists transcripts under `hello-agent/`.

The deployed per-agent buckets are `DESTROY`, but CloudFormation deletes a bucket only when it is empty, and an update replacing them would try. The batch therefore destroys both example stacks before it starts (`glibc-base-image` task 0.1), while their `destroy` still empties the buckets it knows, and its joint verification deploys them fresh.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| Two agents added to one project under one name | synth | the construct throws, naming it |
| An agent name not matching the pattern | synth | the construct throws, naming it |
| `AGENTFORGE_AGENT_NAME` or another owned variable in `environmentVariables` | synth | the construct throws, as for the others |
| A session bucket named without an agent name | each task process's start, building its session store | every task fails `EXECUTION_ERROR`, naming the variable |
| A task record without `agent` | any read of it | throws, naming the task; the request fails |
| `GetTask` or `CancelTask` for another agent's task | the request | A2A's task-not-found; nothing written |
| A key reused across agents | a start | two executions, by design |

## What earns which test

- **Unit:**
  - **Constructs** (`Template` assertions):
    - two agents produce one table, one bucket, one dashboard with a section per agent, one probe Lambda and two readiness resources;
    - the prefix-scoped bucket grant;
    - the refused owned variable, duplicate name and bad name.
  - **The task store**, against its fake table as its tests run today:
    - the `agent` on the record, after `save` and after a derived `LOST`;
    - a record without `agent` throws;
    - another agent's task is absent, and is not written for `LOST`;
    - one key, two agents, two tasks.
  - **The executor:** a task process's environment carries the config's agent name.
  - **The session store:** the prefix, and the throw without a name.
  - **The plugin:** the project and agent construct templates' snapshots.
- **Integration:** `integ` local re-runs the runtime against DynamoDB Local. The `aws` AgentCore fixture is updated to deploy through `AgenticProjectResources`, and re-run. Nothing new is platform behaviour: prefix-conditioned S3 grants are documented IAM.
- **e2e,** in the batch's joint verification (`task-image`'s last group): both examples deploy fresh and pass `e2e-agentcore`, `golden-kata`'s two agents sharing one set of resources, and both pass locally, which proves the key layout on DynamoDB Local.

## Risks / Trade-offs

- [Agents of a project can read each other's task records in IAM terms] → Accepted by the operator: they are trusted alike, and the store scopes reads by agent mechanically.
- [One retention for every agent's transcripts] → A project that needs two retentions is two projects.
- [**BREAKING** for the constructs' props and properties] → No consumer is live. The examples, the fixture and the templates move in this change.
- [A destroy of the example stacks deletes their test data] → It is test data, and each destroy runs only with the operator's approval.
