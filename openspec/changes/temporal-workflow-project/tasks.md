# Tasks

Builds on the generic-names refactor (6248280): generated seams export generic names and the importer aliases them, which every rendered import below assumes.

Group 1 is done with the change's artifacts. Groups 2–5 build the package's side and can proceed in parallel once 2.1 lands (3 and 5 need only 2.1's types; 4 needs 2). Group 6 builds the plugin and needs 2 and 5 for what it renders. 7 generates and verifies `golden-kata-workflows` locally; 8 deploys it; 9 closes the docs.

## 1. Records

- [x] 1.1 §REQ710 in `docs/REQUIREMENTS.md`; §ODO011 (Worker Versioning) in `docs/DESIGN_OPTIONS.md`, next id `ODO012`; [ADR 0016](../../../adr/0016-a-workflow-project-is-a-generated-caller.md) written `proposed`, indexed, and accepted by the operator on 2026-09-30; `docs/research/temporal.md` gains the dated facts the design rests on — verified by reading each against design.md

## 2. `/temporal`

- [x] 2.1 `procedureActivity(procedure, { cancelTask, pollIntervalMilliseconds? })` returning `(input, start: ActivityStart)`; the start's fields from the call, the idempotency key still derived; the task cancelled only when `cancellationDetails()?.cancelRequested`, any other abort rethrowing `CancelledFailure` with the task untouched — verified by unit tests: a requested cancel cancels; `WORKER_SHUTDOWN`, a timed-out cancel and one with no details do not; the start carries the call's routing; the existing refusal and failure-mapping tests on the new signature; smoke-coverage's `temporal-activity` e2e and the README's activity example moved to `(input, start)` in the same commit, so the workspace keeps typechecking — verified also by smoke-coverage's `e2e`
- [x] 2.2 `projectActivities`: walks a project's contracts, one activity per procedure named `<project>.<agent>.<namespace…>.<Procedure>`, each over that agent's procedure client with its `CancelTask` — verified by unit tests over a nested contract and a scripted client, and a typecheck that the client must match the contracts
- [x] 2.3 `temporalConnectConfig` over `@temporalio/envconfig` with `disableFile: true`, refusing an unset address or namespace and a key with a local address, each named; `connectTemporalClient`; `agentsFromEnvironment` — verified by unit tests of each refusal and each setting, and that a profile file in the default location is not read
- [x] 2.4 `runWorker`: the required secrets and a duplicate activity name refused at start, the workflow bundle's absence named with its target, `NativeConnection` from `temporalConnectConfig`, `Worker.create` with the bundle, both activity sets and `shutdownGraceTime` (default 110 s), run until a shutdown signal — verified by unit tests of the refusals; the run itself in 4.1
- [x] 2.5 `@temporalio/worker`, `client`, `workflow` and `envconfig` as optional caret peers, in the catalog; the `/temporal` index and the package-exports test updated — verified by `bundle` passing `publint --strict`

## 3. `/temporal/workflow`

- [x] 3.1 The entry point (source condition, `types`, `default`; a tsdown entry), importing only `@temporalio/workflow` at run time: `proxyProject`, `DEFAULT_ACTIVITY_OPTIONS`, `WorkflowCalls`, `ActivityStart` — verified by unit tests of the paths the proxies call and the options merged, a type test that a wrong procedure or input fails to compile, and `bundleWorkflowCode` bundling a workflow that uses it with no module outside `@temporalio/workflow` in the bundle

## 4. `integ` local

- [x] 4.1 `integ/local/temporal-worker/`: a real worker against the dev server (the CLI on `PATH`) over a scripted procedure client — shut down mid-activity with a second worker taking the retry: no `CancelTask`, the same idempotency key on the retry's start; a workflow's cancel reaching `CancelTask`; `runWorker` exiting on `SIGTERM` inside its grace — verified by `nx run @beruangai/agentforge:integ --configuration=local -- integ/local/temporal-worker`
- [x] 4.2 `.claude/rules/testing.md`: the Temporal CLI is a prerequisite of `integ` local and of a workflow project's `test`, which runs against the dev server with `temporal --version` as a runtime input — verified by reading it against design.md

## 5. `/infra`

- [x] 5.1 `TemporalWorker`: Fargate ARM64 task definition, the image from `directory`, `stopTimeout` 120 s, the Temporal and agents environment, each secret through ECS secrets, its own log group, a service with the circuit breaker and rollback, `minHealthyPercent` 100, a security group with no ingress; refusals at synth for an owned environment key, a secret also as a plain value, a missing `directory`; checkov reasons recorded on resources where it chooses against a rule — verified by template tests of each property, grant and refusal

## 6. The plugin

- [x] 6.1 The workflow project's record: `metadata.generator` `workflow-project`, connection components (`name`, `path`, `packageName`, `key`), `agentforge.detached`; read beside agentic projects through one module, a connection's agentic project resolved from the graph by package name — verified by unit tests of a valid record, an invalid one refused, and a connection whose project is gone failing, named
- [ ] 6.2 `workflow-project` generator: the host `package.json` keys, `tsconfig` files in `@aws/nx-plugin`'s shape, the maintained `worker.ts`, `client.ts`, `agents/*.ts`, `container/*`, the scaffolded workflows, test, activities and `secrets.ts`, the targets `bundle-workflows`, `lock`, `bundle`, `assemble`, `temporal-server`, `serve` (`local`, `hybrid`) — verified by snapshot, a re-run changing nothing, and a collision refused
- [ ] 6.3 Executors `bundle-workflows` (`bundleWorkflowCode` to `dist/{projectRoot}/bundle/workflows.js`) and `bundle-worker` (`bun build`, every `@temporalio/*` external, the build context staged); `lock` learns the worker's layer — verified by unit tests of the commands and staged files, and by bundling and locking the scaffolded project; confirm `bun build` resolves the workspace's conditions and paths, and update design.md if it does not
- [ ] 6.4 `connection` generator and sync: the record appended once; the dependency, `paths`, `agents/activities.ts`, `agents/workflow.ts` and the construct rendered from the connections; a removed record dropped everywhere; the wrong kind of project refused before writing — verified by snapshot of one and two connections, a re-run changing nothing, a removed record, and the refusals
- [ ] 6.5 The workflow project's construct in the shared constructs — `app/workflow-projects/<project>/project.ts` exporting `WorkflowProject`, `WorkflowProjectProps` and `Secrets`, its `index.ts` aliasing them to the project's names, `export *` lines in `app/workflow-projects/index.ts` and `app/index.ts`: typed secrets from `secrets.ts`, a required prop per connection with its `grantInvoke`, `agents` from the runtime configuration, `directory` checked at synth — verified by snapshot, and a template test that the role invokes exactly the connected runtimes
- [ ] 6.6 The package README lists the workflow project's maintained, maintained-key and scaffolded artifacts, the environment it reads, and that a contract output must survive JSON — verified by reading it against the render functions

## 7. `golden-kata-workflows`, locally

- [ ] 7.1 Generated by `workflow-project` and `connection --agenticProject @beruangai/golden-kata`; `writeAndGrade` written by hand; its unit test against the dev server with the agents' activities stubbed; the placeholder removed — verified by `nx run-many -t typecheck,test` and `nx sync:check`, and re-running both generators leaving no diff
- [ ] 7.2 The shared e2e suite and the `local` project; the `e2e` target on `temporal-server`, `serve:local` and golden-kata's `serve-writer` and `serve-grader`, waiting for a poller before starting — verified by `nx run @beruangai/golden-kata-workflows:e2e` against a real model, with the workflow visible in the local UI

## 8. `golden-kata-workflows`, deployed

- [ ] 8.1 `golden-kata-infra`: the application stack's VPC (public subnets, no NAT gateway), cluster and `GoldenKataWorkflows`, its key the operator's `agentforge/temporal-api-key` referenced by name; the `Caller` role and output removed; the stack test asserting the worker's grants; checkov passing; its README naming the operator's secret — verified by `test`, `synth` and `checkov`
- [ ] 8.2 The `hybrid` project and `e2e-hybrid`: the worker spawned from the `bundle` output with `AGENTFORGE_AGENTS` read from the deploy outputs, as the test role — verified by `nx run @beruangai/golden-kata-workflows:e2e-hybrid`
- [ ] 8.3 The `agentcore` project and `e2e-agentcore`: the workflow started on Temporal Cloud and run by the ECS worker — verified by `nx run @beruangai/golden-kata-workflows:e2e-agentcore`, then golden-kata's own `e2e-agentcore` still passing against the same deployment

## 9. Close

- [ ] 9.1 `.env.hybrid.local.example` removed — verified by `git grep -n hybrid.local.example` finding nothing
- [ ] 9.2 ARCHITECTURE §1, §7 (workflow projects), §8 (`/temporal`, `/temporal/workflow`, `TemporalWorker`, layout), §9; ROADMAP A5 (the Temporal layer delivered, S3 filesystems next); GLOSSARY (workflow project, connection, worker); CLAUDE.md's status line — verified by `git grep -n "procedureActivity"` over the docs showing only the new signature
