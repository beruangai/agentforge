# Tasks

Group 1 is the package. Group 2 is where the value is supplied, and needs group 1. Group 3 verifies end to end. Group 4 closes the records.

## 1. Recording and reading

- [ ] 1.1 `IMAGE_VARIABLE` in `core/`; the server's config gains `image`, from the option or the variable, and is required; the executor's `taskMetadata` stamps it. Verified by unit tests:
  - the metadata carries `image`;
  - the server refuses to start without it, naming the variable.
- [ ] 1.2 `TaskView.image`, read and required by the client's wire schema. Verified by unit tests: the view carries it, and a task without it is refused.

## 2. Supplying it

- [ ] 2.1 `AgentRuntime` owns `AGENTFORGE_IMAGE` and sets it from the runtime's rendered container URI, throwing at synth when that is absent, and exposes `image`. Verified by `Template` assertions: the variable is the container URI, and setting it in `environmentVariables` is refused.
- [ ] 2.2 The `serve` executor passes `AGENTFORGE_IMAGE` from the agent's image id file, and fails naming the image build when the file is missing. `integ/local/runtime` passes `image`, and asserts it on a task. Verified by the executor's unit tests and by `nx run @beruangai/agentforge:integ --configuration=local`.

## 3. End to end

- [ ] 3.1 `smoke-coverage-infra` outputs `HelloAgentImage`. The local suite asserts a task's `image` equals the agent's image id file, and the AgentCore suite asserts it equals `HelloAgentImage`. Verified by `nx run @beruangai/smoke-coverage:e2e` and `:e2e-agentcore`, by `nx run @beruangai/golden-kata:e2e` and `:e2e-agentcore` passing unchanged, and by `nx run @beruangai/agentforge:integ --configuration=aws -- integ/aws/agentcore`.

## 4. Records

- [ ] 4.1 Verify each record by reading it against design.md:
  - **ARCHITECTURE §4:** a task's metadata carries `image`. **§7:** `AgentRuntime` sets it, and `serve` sets it locally;
  - **DESIGN_OPTIONS:** §ODO010 removed, its id spent;
  - **GLOSSARY:** the image on a task;
  - **README:** `TaskView`'s `image`, where the README shows what a caller reads.
