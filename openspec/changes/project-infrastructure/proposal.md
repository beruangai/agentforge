# Proposal

## Why

Each deployed agent today provisions its own copy of four things: a task table, a session bucket, a dashboard and a readiness-probe Lambda. A project with several agents therefore has several of each, and one dashboard per agent costs more and is harder to read than one view of the project.

The operator settled the shape on 2026-10-08: a project's agents share all four, one per agentic project. Agents within a project are trusted alike — no agent writes with elevated permissions — and a task is addressed by its uuid, so sharing the table is mechanical. The agent becomes a field on its tasks, not part of their key.

It has to happen before StrategyFoundry deploys. Once tasks and transcripts live in deployed resources, moving them to new owners means replacing those resources.

## What Changes

- **One set of shared resources per project.** A new `/infra` construct, `AgenticProjectResources`, provisions:
  - the project's task table;
  - its session bucket, private, with one retention for every agent;
  - its dashboard, with a section per agent;
  - one readiness probe that checks each agent on deploy.

  It owns the removal policy and the session retention.
- **`AgentRuntime` takes `project` and `agentName`.**
  - It provisions only the runtime.
  - It points the runtime at the project's table and bucket, and sets `AGENTFORGE_AGENT_NAME` itself.
  - It grants the runtime the table, and only its own agent's prefix of the bucket.
  - It adds the agent's section to the dashboard and its check to the probe.
  - **BREAKING:** its `taskTable`, `sessionBucket` and `dashboard` properties go, as do its `removalPolicy` and `sessionRetention` props. No consumer is live.
- **A task records its agent.**
  - Tasks are still keyed by task id alone, and the agent is a field on the record.
  - An idempotency key binds per agent, so one key used with two agents names two executions, as it does today.
  - A runtime answers `GetTask` and `CancelTask` only for its own agent's tasks; another agent's task is not found.
- **Transcripts are stored under the agent's name.** A session resumes only in the agent that started it, as today.
- **The generated project construct** creates the shared resources once, takes `removalPolicy` and `sessionRetention` at project level, and passes `project` and `agentName` to each agent. Each agent's generated props no longer carry those two options.
- **The examples' infrastructure stacks** move their options and outputs to the project, and their `destroy` empties the one session bucket. The deployed stacks are destroyed before the batch starts (`glibc-base-image` task 0.1), because CloudFormation cannot delete a non-empty per-agent bucket on update.
- **ADR 0006 and ADR 0011 are amended in place** (no consumer depends on them): one table and one session bucket per project, an agent's records and transcripts scoped by its name, and IAM partitioning of the table rejected by the operator's choice.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `infra-agent-runtime`:
  - an agent is deployed within its project, whose agents share task state, session storage, a dashboard and the readiness check;
  - the retention is chosen per project;
  - an agent's tasks and transcripts are its own within what is shared.
- `runtime-task-admission`: an idempotency key names one logical execution per agent.
- `runtime-observability`: the counts are per agent, on the project's one dashboard.
- `plugin-agentic-connection`: the project construct provisions what the project's agents share, and takes their shared options.

## Impact

- **Infrastructure (`/infra`):**
  - new `AgenticProjectResources`;
  - `AgentRuntime`'s props and properties change;
  - the readiness probe serves several agents' checks.
- **Runtime:** the task store records and checks the agent, and binds keys per agent; the executor passes the agent's name to every task process.
- **Harness:** the S3 session store prefixes keys with the agent's name.
- **Plugin:** the maintained project construct and agent construct templates, with their snapshots.
- **Examples:** both infrastructure stacks, their `empty-buckets` scripts and READMEs, and `smoke-coverage`'s AgentCore suite.
- **Batch:** the third of four A6 changes, applied in order with no deploy between them: `glibc-base-image`, `strict-contracts`, `project-infrastructure`, `task-image`. Their end-to-end verification runs once, after all four, in `task-image`'s last group. Overlaps:
  - `glibc-base-image` destroys the example stacks first, and also edits `smoke-coverage`'s AgentCore suite and ARCHITECTURE §7;
  - `task-image` adds `image` to `AgentRuntime` after this change reshapes it, and deploys its integration fixture through `AgenticProjectResources`.
- **No change** to the A2A wire, the task protocol, the client, the contract or the local serving: locally each agent keeps its own DynamoDB Local, and its keys are scoped the same way.
- **Requirements:**
  - serves §REQ604 (one dashboard) and §REQ402;
  - keeps §REQ305, a key per agent;
  - keeps §REQ708: callers are still granted exactly their agents, and runtimes only their own prefix;
  - keeps §REQ706.
- **Open options:** none depended on. §ODO010 (the version on a task's record) is a separate change.

## Non-goals

- Sharing across projects: one table or one dashboard for a whole solution.
- Per-agent retention inside a project's bucket.
- Scoping the table by agent in IAM, for example with `dynamodb:LeadingKeys`. Agents of one project are trusted alike, by the operator's choice.
- Migrating tasks or transcripts from the per-agent resources. No consumer has any.
- Changing local serving.
