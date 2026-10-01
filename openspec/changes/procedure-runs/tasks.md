# Tasks

Group 1 records the requirements. Groups 2–4 are independent package work: several runs, stop guards, paths and `distill`. Group 5 needs 3 and runs against a real model. Group 6 lands the capabilities on the examples and needs 2–4. Group 7 closes the docs.

## 1. Records

- [x] 1.1 `docs/REQUIREMENTS.md`, verified by reading each against the spec deltas:
  - §REQ206 amended: each run settles on its own agent's last declared answer, and the task's outcome is what the procedure returns;
  - §REQ207 added: a procedure makes any number of runs, or none, in its one process, each recorded;
  - §REQ208 added: stop guards checked in the agent's turn, bounded, failing loudly;
  - §REQ209 added: distilling documents into bounded context.

## 2. Several runs

- [x] 2.1 Task-process unit tests against the scripted `query()`, verified by `nx run @beruangai/agentforge:test`:
  - two `context.runAgent` calls emit two records and the task completes with the handler's value;
  - a handler with no run completes with no record;
  - a run started after the signal aborted throws `TaskCanceled`, never reaching the SDK, and the task ends `TASK_STATE_CANCELED`.

## 3. The answer check

- [x] 3.1 `StopGuard`, `StopGuardDenial` and `AgentRunSpec.guardrails.stop`, exported from `/agent`. Every run gets the kernel's own `PreToolUse` entry (matcher `StructuredOutput`), after the procedure's hooks. On each submission it collects the contract's `safeParseAsync` of the unwrapped input and every guard's result:
  - all failures are joined into one `deny` reason, the contract's first, and logged as `agentforge.answer.refused`;
  - a guard's rejection is recorded, the run aborted, and the run fails `EXECUTION_ERROR` naming it.

  Verified by unit tests of the hook:
  - a submission the contract refuses (a refinement), including a wrapped root;
  - all guards run though one denies;
  - the contract's failure and the denials in one reason;
  - a passing submission returns `{}`;
  - a rejection recorded and the run failing `EXECUTION_ERROR`;
  - the entry is present on a run with no guards, and the procedure's own `PreToolUse` hooks are kept.
- [x] 3.2 `settle` carries `result.errors` into the `OUTPUT_INVALID` cause for `error_max_structured_output_retries`, verified by the kernel unit test for that subtype asserting the message.

## 4. Mount paths and `distill`

- [x] 4.1 `MountedFilesystem.path` and `writablePath`, built by `MountLifecycle`. Verified by unit tests over the mount at `/workspace/vault`, using `path.matchesGlob` against the write globs:
  - a nested path resolves;
  - an absolute path, `..`, and a path normalising out of the mount are refused, naming the path and the mount;
  - `writablePath` accepts under `**`, under `notes/**` and an exact file, and refuses `index.md` under `notes/**`, naming the scope.
- [x] 4.2 `distill(context, { documents, instruction, capTokens?, model? })` in `server/harness/distill.ts`, exported from `/agent` with `DistillDocument` and `DistillSpec`. Verified by unit tests against a stub `runAgent`:
  - within the cap: one `document` block per document and no run;
  - over the cap: one run with the utility preset (`tools: []`, `settingSources: []`, `dontAsk`, `maxTurns: 3`, the model), line-numbered documents and the instruction last, returning one `distillation` block;
  - a distillation at 1.5× the cap passes, and one past it fails `OUTPUT_INVALID` carrying it;
  - no documents returns `[]`; a non-positive `capTokens` throws before any run.

## 5. Model `integ`

- [x] 5.1 `integ/model/answer-check/answer-check.test.ts` through `runAgent` against a real model. Verified by `nx run @beruangai/agentforge:integ --configuration=model -- integ/model/answer-check`:
  - a contract with a `format: uri` field, the prompt inviting a non-URL first: the run returns a valid URL;
  - a guard requiring a file the agent can `Write`: the agent is denied, writes the file and answers again, and the run returns the answer with the file present;
  - a guard that never passes: the run fails `OUTPUT_INVALID` and the cause names the guard's reason.

## 6. Examples

- [ ] 6.1 `golden-kata`'s writer guards its kata and solution files through `kata.path`, verified by `nx run @beruangai/golden-kata:e2e`, and by `e2e-agentcore` after its deploy.
- [ ] 6.2 `smoke-coverage`'s `hello-agent` gains `DistillThenAnswer`: documents and a question in; it distills, then runs, and returns the answer with whether it distilled. Verified by `nx run @beruangai/smoke-coverage:e2e`, and by `e2e-agentcore` after its deploy, in local and AgentCore suites:
  - large documents under a small cap record two runs on the task, and the answer is grounded in them;
  - documents within the cap record one run.

## 7. Docs

- [ ] 7.1 Verified by reading them against design.md:
  - **ARCHITECTURE §6:** a procedure is one process whose runs are its own to coordinate, each settled and recorded; the answer check — the contract and the stop guards on the submission, bounded by the CLI's retry limit; `distill`; mount path resolution;
  - **ARCHITECTURE's structured-output bullet and `research/claude-agent-sdk.md`:** a `format` or refinement is now refused in-turn, no longer found only after the run;
  - **GLOSSARY:** stop guard, as distinct from the SDK's `Stop` event; utility run; distillation;
  - **the package README:** the agent entry's new exports.
