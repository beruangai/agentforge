# Tasks

Groups 1 and 2 are independent: the constructs, and the runtime and harness. Group 3 moves the plugin's templates and needs group 1. Group 4 lands everything on the examples. Group 5 closes the records.

## 1. Constructs

- [ ] 1.1 `AgenticProjectResources` in `src/infra/agentic-project-resources.ts`, exported from `/infra`, owns the task table, the session bucket, the dashboard and the readiness probe, with their settings moved unchanged from `AgentRuntime`, and `addAgent`, which adds the agent's dashboard section and its readiness check and refuses a duplicate name. Verified by `nx run @beruangai/agentforge:test` (`Template` assertions):
  - one project with two agents has one table, one bucket, one dashboard with two sections, one probe Lambda and two readiness resources;
  - a duplicate agent name is refused.
- [ ] 1.2 `AgentRuntime` takes `project` and `agentName`, and loses `removalPolicy`, `sessionRetention`, `taskTable`, `sessionBucket` and `dashboard`. It sets and owns `AGENTFORGE_AGENT_NAME`, grants the table, and grants the bucket under `<agentName>/` only. The integration fixture `agentforge-runtime-app.ts` deploys through `AgenticProjectResources`. Verified by unit tests:
  - the runtime's environment names the project's table and bucket and the agent;
  - the bucket grant is prefix-scoped, including `s3:ListBucket`'s `s3:prefix` condition;
  - `AGENTFORGE_AGENT_NAME` set by the consumer is refused, as is a name not matching `/^[a-z][a-z0-9-]*$/`.

## 2. Runtime and harness

- [ ] 2.1 `DynamoDBTaskStore` takes the agent's name, set from `AGENTFORGE_AGENT_NAME` in `server.ts`. It writes `agent` on the task record, treats another agent's task as absent everywhere it reads one, and binds keys as `key#<agent>#<idempotencyKey>`. Verified by its unit tests, and by `nx run @beruangai/agentforge:integ --configuration=local` against DynamoDB Local:
  - the record's agent;
  - another agent's task is not found by `load`, `GetTask` or `CancelTask`, and is not rewritten as `LOST`;
  - one key on two agents starts two tasks.
- [ ] 2.2 `S3SessionStore` takes a `prefix`, and `sessionStoreFromEnvironment` passes `AGENTFORGE_AGENT_NAME`, throwing when the bucket is set without it. Verified by unit tests:
  - parts are written and loaded under `<agent>/`;
  - a store from an environment with a bucket and no name throws, naming the variable.

## 3. Plugin

- [ ] 3.1 The project construct template creates `AgenticProjectResources` once from `removalPolicy` and `sessionRetention` at the top of its props, and passes `project` to each agent. The agent construct template passes `agentName` from its component, and its `AgentProps` omit `project`, `agentName`, `removalPolicy` and `sessionRetention`. Verified by `nx run @beruangai/agentforge:test` (the generators' snapshots), and by `nx sync` regenerating both examples' constructs with `nx sync:check` then clean.

## 4. Examples

- [ ] 4.1 Both examples' infrastructure stacks set `removalPolicy` on the project and output one `SessionBucketName`. `smoke-coverage`'s AgentCore suite lists transcripts under `hello-agent/`. Verified by `nx run-many -t synth` for both infrastructure projects, and by `nx run @beruangai/smoke-coverage:e2e` and `nx run @beruangai/golden-kata:e2e` locally.
- [ ] 4.2 With the operator's approval for each, destroy `smoke-coverage-infra` and `golden-kata-infra`, then verify by `nx run @beruangai/smoke-coverage:e2e-agentcore` and `nx run @beruangai/golden-kata:e2e-agentcore`, each deploying fresh, and by `nx run @beruangai/agentforge:integ --configuration=aws -- integ/aws/agentcore`.

## 5. Records

- [ ] 5.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §7:** deploying is `AgenticProjectResources` for a project, and `AgentRuntime` per agent; what each owns. **§4 and §6:** a task records its agent, a key binds per agent, and transcripts live under the agent's name;
  - **the package README's infrastructure section:** the project's shared options;
  - **GLOSSARY:** project resources; the project construct's entry;
  - **REQUIREMENTS:** unchanged — §REQ604's "one dashboard" is met per project.
