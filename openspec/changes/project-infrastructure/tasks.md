# Tasks

Applied third in the A6 batch, after `strict-contracts`; the example stacks were destroyed before the batch began (`glibc-base-image` task 0.1). Groups 1 and 2 are independent: the constructs, and the runtime and harness. Group 3 moves the plugin's templates and needs group 1. Group 4 lands everything on the examples. Group 5 closes the records. The e2e and the `aws` integration run once for the batch, in `task-image`'s last group.

## 1. Constructs

- [x] 1.1 `AGENT_NAME_PATTERN` in `core/agent-name.ts`, and the plugin's `KebabNameField` built from it. Verified by `nx run @beruangai/agentforge:test`.
- [x] 1.2 `AgenticProjectResources` in `src/infra/agentic-project-resources.ts`, exported from `/infra`, owns the task table, the session bucket, the dashboard and the readiness probe, with their settings moved unchanged from `AgentRuntime`, and `addAgent`, which adds the agent's dashboard section, titled by its name, and its readiness check, and refuses a duplicate name. Verified by `nx run @beruangai/agentforge:test` (`Template` assertions):
  - one project with two agents has one table, one bucket, one dashboard with a section per agent, one probe Lambda and two readiness resources;
  - a duplicate agent name is refused.
- [x] 1.3 `AgentRuntime` takes `project` and `agentName`, and loses `removalPolicy`, `sessionRetention`, `taskTable`, `sessionBucket` and `dashboard`. It sets and owns `AGENTFORGE_AGENT_NAME`, grants the table, and grants the bucket under `<agentName>/` only. The integration fixture `agentforge-runtime-app.ts` deploys through `AgenticProjectResources`. Verified by unit tests:
  - the runtime's environment names the project's table and bucket and the agent;
  - the bucket grant is prefix-scoped, including `s3:ListBucket`'s `s3:prefix` condition;
  - `AGENTFORGE_AGENT_NAME` set by the consumer is refused, as is a name not matching `AGENT_NAME_PATTERN`.

## 2. Runtime and harness

- [x] 2.1 `DynamoDBTaskStore(client, tableName, agentName, metrics)`, constructed in `server.ts` from `config.agentName`. Every task-record write sets `agent`, the derived-`LOST` Put included; a record without `agent` throws; another agent's task is absent everywhere a task is read; keys bind as `key#<agent>#<idempotencyKey>`. Verified by its unit tests, against its fake table, and by `nx run @beruangai/agentforge:integ --configuration=local` against DynamoDB Local:
  - the record's agent, after `save` and after a derived `LOST`;
  - a record without `agent` throws;
  - another agent's task is not found by `load`, `GetTask` or `CancelTask`, and is not rewritten as `LOST`;
  - one key on two agents starts two tasks.
- [x] 2.2 `ExecutorConfig` takes `agentName`, and each task process is spawned with `AGENTFORGE_AGENT_NAME` set from it. Verified by a unit test of the task process's environment.
- [x] 2.3 `S3SessionStore({ bucket, prefix, client })`, and `sessionStoreFromEnvironment` passes `AGENTFORGE_AGENT_NAME`, throwing when the bucket is set without it. Verified by unit tests:
  - parts are written and loaded under `<agent>/`;
  - a store from an environment with a bucket and no name throws, naming the variable.

## 3. Plugin

- [x] 3.1 The project construct template creates `AgenticProjectResources` once from `removalPolicy` and `sessionRetention` at the top of its props, takes each agent's options without `project`, and passes `project` to each agent. The agent construct template passes `agentName` from its component, and its `AgentProps` omit `agentName`. Verified by `nx run @beruangai/agentforge:test` (the generators' snapshots), and by `nx sync` regenerating both examples' constructs with `nx sync:check` then clean.

## 4. Examples

- [ ] 4.1 Both examples' infrastructure stacks set `removalPolicy` on the project and output one `SessionBucketName`; each `scripts/empty-buckets.ts` empties it, and each infrastructure README says so. `smoke-coverage`'s AgentCore suite lists transcripts under `hello-agent/`. Verified by `nx run-many -t synth test` for both infrastructure projects; the deploys run in `task-image`'s last group.

## 5. Records

- [ ] 5.1 Verify each record by reading it against design.md:
  - **ADR 0006**, amended in place: one table per project, a task's agent on its record, keys bound per agent, IAM partitioning of the table rejected by the operator's choice;
  - **ADR 0011**, amended in place: one session bucket per project, an agent's transcripts under its name;
  - **ARCHITECTURE §7:** deploying is `AgenticProjectResources` for a project and `AgentRuntime` per agent, what each owns, one dashboard with a section per agent, the probe shared. **§2:** `sessionId` persists in the project's session bucket, and an idempotency key names one execution per agent. **§4 and §6:** a task records its agent, a key binds per agent, transcripts live under the agent's name. **§5:** a task process is given the agent's name. **§8:** `/infra`'s constructs;
  - **the root README's known limits:** `sessionRetention` is the project's;
  - **GLOSSARY:** project resources; "Session store" names the project's bucket and the agent's prefix;
  - **ROADMAP:** the A6 item delivered;
  - **REQUIREMENTS:** unchanged — §REQ604's "one dashboard" is met per project.
