# Design

## Context

See proposal.md — Why. What holds today:

- **`AgentRuntime`** (`src/infra/agent-runtime.ts`) provisions, per agent:
  - the L2 `Runtime`;
  - a `TaskTable` (key `pk`, TTL, PITR, pay per request);
  - a `SessionBucket` (private, versioned, its lifecycle set by `sessionRetention`);
  - a `Dashboard` from `operationalDashboard`;
  - a `ReadinessProbe` Lambda with its log group, and a `Custom::AgentForgeReadiness` resource.

  It owns the environment variables `AGENTFORGE_TASK_TABLE_NAME`, `AGENTFORGE_SESSION_BUCKET`, `AGENTFORGE_METRICS_RUNTIME_NAME`, `AGENTFORGE_SECRETS`, `AGENTFORGE_TELEMETRY` and `AGENTFORGE_FILESYSTEM_BUCKETS`, and exposes `taskTable`, `sessionBucket` and `dashboard`.
- **The task store** (`server/runtime/task-store.ts`) keys items by `pk`:
  - `task#<id>`, `input#<id>` and `output#<id>` for a task;
  - `key#<idempotencyKey>` for the binding of a key to its task.

  `load` derives `LOST` from a lapsed lease. `cancelTask` stops the task only if it runs in this container, and otherwise answers with the stored task.
- **The S3 session store** (`server/harness/session-store.ts`) keys parts as `{projectKey}/{sessionId}[/{subpath}]/part-…jsonl`. Every agent's `projectKey` is the same, since every run's cwd is `/workspace/agentic/agent`; session ids are uuids.
- **The agent's name** is `ENV AGENTFORGE_AGENT_NAME` in the agent's generated Dockerfile. The server requires it, and task processes inherit the server's environment.
- **The generated constructs:**
  - The project construct (`AgenticProject`) creates each agent's construct from `props.agents.<agent>`.
  - Each agent's construct (`Agent extends AgentRuntime`) supplies the artifact and registers the runtime configuration.
  - The examples' stacks pass `removalPolicy` per agent and output each agent's session bucket. `smoke-coverage`'s AgentCore suite lists transcripts in that bucket.
- **The integration fixture** `integ/aws/agentcore/__fixtures__/agentforge-runtime-app.ts` deploys one `AgentRuntime` directly.

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
   * Called by `AgentRuntime`: adds the agent's dashboard section and its
   * readiness check, granting the probe the runtime. Refuses a name already added.
   */
  addAgent(agent: { readonly agentName: string; readonly runtime: Runtime; readonly scope: Construct }): void;
}
```

- The table, bucket and probe keep today's settings, moved unchanged.
- `operationalDashboard` becomes a section builder appended to one dashboard.
- Each agent's readiness `CustomResource` stays in the agent's own scope, so removing an agent removes its check. Its `serviceToken` is the project's probe, which already reads the ARN and version from the resource's properties.
- `addAgent` is public only because `AgentRuntime` is another class. It is documented as `AgentRuntime`'s and refuses a duplicate name, so two agents can never share a key scope.

*Alternative:* a project construct inside the plugin's generated code alone. The shared resources' settings and grants are AgentForge's to keep correct, and the integration fixture deploys without the plugin, so the construct belongs in `/infra`.

### `AgentRuntime` takes `project` and `agentName`

```ts
export interface AgentRuntimeProps
  extends Omit<RuntimeProps, 'protocolConfiguration' | 'authorizerConfiguration'> {
  /** The project's shared resources, which this agent's tasks and transcripts live in. */
  readonly project: AgenticProjectResources;
  /** The agent's name within its project, as its image names it; matches /^[a-z][a-z0-9-]*$/. */
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

- **The variable it owns:** `AGENTFORGE_AGENT_NAME` joins them. The construct sets it from `agentName`, overriding the image's `ENV`. A deployed agent is then named by exactly what its grants are scoped to, and setting it in `environmentVariables` is refused.
- **Its grants:**
  - `taskTable.grantReadWriteData(runtime)`, as today;
  - read and write of `sessionBucket` objects under `<agentName>/*`;
  - `s3:ListBucket` conditioned on `s3:prefix` `<agentName>/*`.

### The task store scopes by agent, keyed by task id

`DynamoDBTaskStore` takes the agent's name:
- **Saving a task** writes `agent` on the task record. The `pk` is unchanged (`task#<id>`, `input#<id>`, `output#<id>`).
- **Reading a task** (`readTask`, under `load`, `GetTask` and `CancelTask`'s answer) treats a record whose `agent` differs as absent. The caller sees A2A's task-not-found, and the record is never written, not even to derive `LOST`.
- **A key binds per agent**, as `key#<agent>#<idempotencyKey>`.

Local serving is unchanged: each agent has its own DynamoDB Local, and the same code path scopes it identically (§REQ701).

*Alternative:* `pk` as `<agent>#task#<id>`. That splits the key the operator wants to stay the task's uuid, for no isolation the agent field does not give.

### Transcripts are stored under the agent's name

`S3SessionStore` takes a `prefix`, and `sessionStoreFromEnvironment` passes `AGENTFORGE_AGENT_NAME`. A bucket named without an agent name throws, rather than writing unprefixed. Keys become `<agent>/{projectKey}/{sessionId}[/{subpath}]/part-…jsonl`. A resume therefore loads only the agent's own sessions, and the grant makes another agent's unreachable as well.

### The generated constructs

- **The project construct** creates `this.resources = new AgenticProjectResources(this, 'Resources', { projectName, removalPolicy, sessionRetention })`. It takes `removalPolicy` and `sessionRetention` at the top of `AgenticProjectProps`, and passes `project: this.resources` to each agent.
- **Each agent's construct** passes `agentName: '<agent>'` from its component record, the same record its Dockerfile's `ENV` is rendered from. Its `AgentProps` omit `project`, `agentName`, `removalPolicy` and `sessionRetention`; the constructor takes `project` beside them.

The construct ids `TaskTable`, `SessionBucket` and `Dashboard` leave each agent's scope, so a deployed stack replaces them.

### The examples redeploy from scratch

The per-agent buckets are `DESTROY` in the examples, but CloudFormation can delete a bucket only when it is empty, and an update would try. So each example's infrastructure is destroyed with its `destroy` target, which empties its buckets first, and then deployed. The operator approves each destroy when it is run. The stacks output `SessionBucketName` once per project; `smoke-coverage`'s suite lists transcripts under `hello-agent/`.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| Two agents added to one project under one name | synth | the construct throws, naming it |
| An agent name not matching the pattern | synth | the construct throws, naming it |
| `AGENTFORGE_AGENT_NAME` or another owned variable in `environmentVariables` | synth | the construct throws, as for the others |
| A session bucket named without an agent name | the first run that persists | the run throws `EXECUTION_ERROR`, naming the variable |
| `GetTask` or `CancelTask` for another agent's task | the request | A2A's task-not-found; nothing written |
| A key reused across agents | a start | two executions, by design |

## What earns which test

- **Unit:**
  - **Constructs** (`Template` assertions):
    - two agents produce one table, one bucket, one dashboard with two sections, one probe Lambda and two readiness resources;
    - the prefix-scoped bucket grant;
    - the refused owned variable, duplicate name and bad name.
  - **The task store against DynamoDB Local**, as its tests run today:
    - the `agent` on the record;
    - another agent's task is absent, and is not written for `LOST`;
    - one key, two agents, two tasks.
  - **The session store:** the prefix, and the throw without a name.
  - **The plugin:** the project and agent construct templates' snapshots.
- **Integration:** the `aws` AgentCore fixture is updated to deploy through `AgenticProjectResources`, and re-run. Nothing new is platform behaviour: prefix-conditioned S3 grants are documented IAM.
- **e2e:** both examples deploy fresh and pass `e2e-agentcore`, `golden-kata`'s two agents sharing one set of resources. Both pass locally too, which proves the key layout on DynamoDB Local.

## Risks / Trade-offs

- [Agents of a project can read each other's task records in IAM terms] → Accepted by the operator: they are trusted alike, and the store scopes reads by agent mechanically.
- [One retention for every agent's transcripts] → A project that needs two retentions is two projects.
- [**BREAKING** for the constructs' props and properties] → No consumer is live. The examples, the fixture and the templates move in this change.
- [A destroy of the example stacks deletes their test data] → It is test data, and the destroy runs only with the operator's approval.
