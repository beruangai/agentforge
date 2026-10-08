# Tasks

Applied last in the A6 batch, after `project-infrastructure`. Group 1 is the package. Group 2 is where the value is supplied, and needs group 1. Group 3 is this change's end-to-end proof. Group 4 closes the records. Group 5 is the batch's joint verification, run once after all four changes are applied.

## 1. Recording and reading

- [x] 1.1 `AGENT_IMAGE_VARIABLE` in `core/agent-image.ts`; `ServerConfig.image`, from the option or the variable, required; `ExecutorConfig` and `GatewayConfig` take it from the config, and `taskMetadata` takes it as a parameter at both call sites. Verified by unit tests:
  - the metadata carries `image`;
  - a start the gateway rejects for its size carries `image`;
  - the server refuses to start without it, naming the variable.
- [x] 1.2 `TaskView.image`, read and required by the client's wire schema. Verified by unit tests: the view carries it, and a task without it is refused.

## 2. Supplying it

- [ ] 2.1 `AgentRuntime` owns `AGENTFORGE_AGENT_IMAGE` and sets it from the runtime's rendered container URI, throwing at synth when that is absent, and exposes `readonly image: string`. Verified by `Template` assertions: the variable is the container URI, and setting it in `environmentVariables` is refused.
- [ ] 2.2 The `serve` executor runs the agent's container by the id in its image id file and passes `AGENTFORGE_AGENT_IMAGE` from it, failing, naming the image build, when the file is missing. `integ/local/runtime` passes `image`, and asserts it on a task. Verified by the executor's unit tests and by `nx run @beruangai/agentforge:integ --configuration=local`.

## 3. End to end

- [ ] 3.1 `smoke-coverage-infra` outputs `HelloAgentImage`. The local suite asserts a task's `image` equals the agent's image id file, and the AgentCore suite asserts it equals `HelloAgentImage`. Verified by `nx run-many -t typecheck lint` for `smoke-coverage` and `nx run @beruangai/smoke-coverage-infra:synth`; the suites run in group 5.

## 4. Records

- [ ] 4.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §4:** a task's metadata carries `image`. **§7:** `AgentRuntime` sets it, and `serve` runs by and passes the image id locally;
  - **ADR 0008:** the mixed-version bullet and its 2026-09-29 amendment say a task records its image, amended in place;
  - **`docs/research/agentcore-runtime.md`:** the note on draining sessions points to the image on the task, not to §ODO010;
  - **DESIGN_OPTIONS:** §ODO010 removed, its id spent;
  - **GLOSSARY:** the image on a task;
  - **README:** `TaskView`'s `image`, where the README shows what a caller reads;
  - **ROADMAP:** the A6 item delivered — written in 5.5, once the joint verification passes.

## 5. The batch's joint verification

Run once, after `glibc-base-image`, `strict-contracts`, `project-infrastructure` and this change are applied, against the example stacks destroyed in `glibc-base-image` task 0.1; each deploy is fresh. A failure is fixed in the change that owns it, and the group re-run.

- [ ] 5.1 `nx run @beruangai/agentforge:integ --configuration=local` and `nx run @beruangai/agentforge:integ --configuration=aws` pass: strict contracts, the agent-scoped task store on DynamoDB Local, `image` on a task; the AgentCore fixture on the Debian pin, deployed through `AgenticProjectResources`, and `filesystem-s3-sync` with `s7cmd` in the Debian image.
- [ ] 5.2 `nx run @beruangai/smoke-coverage:e2e` and `nx run @beruangai/smoke-coverage:e2e-agentcore` pass: `ReportNautilusTraderVersion` answers `1.231.0`, `image` matches, transcripts are listed under `hello-agent/`, and everything the suites already covered holds.
- [ ] 5.3 `nx run @beruangai/golden-kata:e2e` and `nx run @beruangai/golden-kata:e2e-agentcore` pass: two agents sharing one set of resources, with strict contracts.
- [ ] 5.4 `nx run @beruangai/golden-kata-workflows:e2e` and `nx run @beruangai/golden-kata-workflows:e2e-agentcore` pass: the activities' clients on strict contracts, and the worker's image on its Debian dependency stage.
- [ ] 5.5 `glibc-base-image` task 3.1 is ticked, citing 5.1–5.4, and the ROADMAP moves the batch's four A6 items to delivered, each with its change and the date.
