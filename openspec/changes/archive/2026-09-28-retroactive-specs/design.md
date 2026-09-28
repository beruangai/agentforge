# Design

Guidance, not prescription. Nothing is built by this change; it specifies what A1 and A2 built.

## How the specs are written

- **The highest seam first.** A requirement states what a consumer gets — through the contract, the client, the Temporal activity, `runAgent`, or the construct — and never how: no providers, module names, constants or wire shapes the consumer does not see. `ARCHITECTURE.md` keeps the how.
- **Scenarios state behaviour a test already verifies.** The table below maps each to its test; a ⚠ is a scenario no test covers, or covers only in part. A ⚠ also marks where the code falls short of the spec today, as the A4 audit found.
- **Test paths** are relative to `packages/agentforge/` unless they start `examples/`.

## Coverage

### core-procedure-contract

| Scenario | Covered by |
|---|---|
| A caller's build cannot reach agent code | `src/package-exports.test.ts` — `/agent` only; ⚠ `/server` unchecked |
| A caller compiled against a different contract | `integ/local/runtime/runtime.test.ts` "rejects a caller compiled against a different contract, before any work"; `src/server/harness/task-process.test.ts` "rejects a contract hash it does not serve" |
| An unknown procedure or malformed input | `task-process.test.ts` "rejects an unknown procedure and malformed input" |
| A changed time budget stays compatible | `src/core/contract/procedures.test.ts` "hashes its shape, not its meta" |
| A procedure returns what its contract refuses | `task-process.test.ts` "fails an outer output the contract refuses"; ⚠ the payload is not kept |
| An outcome too large to carry | ⚠ none |

### harness-kernel-settlement

| Scenario | Covered by |
|---|---|
| A conforming answer | `src/server/harness/kernel.test.ts` "returns the structured answer, the session id and a record"; `examples/hello-agent/e2e/local/local-agent.test.ts` |
| No conforming answer | `kernel.test.ts` "classifies success with no structured output", "classifies a non-conforming answer" |
| No answer at all | `kernel.test.ts` "fails when the stream ends with no result" |
| Dispatched work completes before the answer counts | `integ/model/kernel-settlement/foreground-settlement.test.ts` |
| A second answer | `kernel.test.ts` "takes the first result and ignores a later one" |
| A limit ends the run | `kernel.test.ts` "classifies maxTurns", "classifies maxBudgetUsd"; `integ/model/kernel-settlement/limits-end-with-a-result.test.ts` |
| The usage limit | `kernel.test.ts` "classifies a 429" — ⚠ the reset time (`retryAfter`) is not asserted |
| A procedure's own cause | `task-process.test.ts` "carries the kernel's cause through oRPC"; `runtime.test.ts` "starts a new attempt once the previous one failed" |
| Cancelled mid-turn | `kernel.test.ts` "interrupts on cancel and reports the task cancelled"; `task-process.test.ts` "reports a cancel as cancelled"; `local-agent.test.ts` "cancels a run mid-turn" |
| A procedure adds to its house's guardrails | `src/server/harness/options.test.ts` "accumulates lists, merges objects, and lets a later scalar win"; ⚠ an `undefined` part erases them |
| A guardrail that would never fire | `kernel.test.ts` "fails the run before its first turn when a guardrail would never fire" |
| A run's record | `kernel.test.ts` "returns the structured answer, the session id and a record"; `local-agent.test.ts` "…and records the run" |
| Credentials stay out of the record | ⚠ none — env reduced to names is not asserted |

### harness-session-persistence

| Scenario | Covered by |
|---|---|
| Resumed in another container | `examples/hello-agent/e2e/agentcore/deployed-agent.test.ts` "resumes a session in another container, from its transcript in S3" |
| Resumed locally | `local-agent.test.ts` "resumes the session it started" |
| A procedure's own store | `kernel.test.ts` "mirrors to the deployment's store, unless the procedure names its own" |
| Part of the transcript was not persisted | `kernel.test.ts` "fails the run when an assistant message never reached the store"; `integ/model/session-store/mirror-covers-the-run.test.ts` |
| The store reports a failure | ⚠ none — a `mirror_error` failing the run is not tested |
| A corrupt transcript | `src/server/harness/session-store.test.ts` "fails a load over a line that is not JSON" |

### runtime-task-admission

| Scenario | Covered by |
|---|---|
| A start returns before the work | `runtime.test.ts` "runs a procedure to its typed output" |
| A retry attaches | `runtime.test.ts` "attaches a retry to the running task, and later to its outcome"; `local-agent.test.ts`; `integ/aws/agentcore/agentforge-runtime.test.ts`; `deployed-agent.test.ts` |
| A new attempt after a failure | `runtime.test.ts` "starts a new attempt once the previous one failed, telling it how"; after `LOST`: `agentforge-runtime.test.ts`, `deployed-agent.test.ts`; ⚠ two attempts can run at once |
| A key reused in another runtime session | `runtime.test.ts` "refuses a key reused in another runtime session" |
| Beyond the admission limit | `runtime.test.ts` "rejects a start beyond the admission limit rather than queueing it" |
| A continuity key already running | ⚠ none |

### runtime-task-execution

| Scenario | Covered by |
|---|---|
| A later outcome does not replace an ended task | `runtime.test.ts` "derives a task lost once its lease lapses, counts it once, and refuses a later write over it"; ⚠ a later `FAILED` replaces a derived `LOST` |
| Read after the container is gone | `agentforge-runtime.test.ts` and `deployed-agent.test.ts` "ends a task LOST when the platform stops its container…" |
| The procedure's budget, or the call's | `runtime.test.ts` "fails a task at the time budget its procedure declares, unless the call overrides it" |
| A cooperative cancel | `runtime.test.ts` "cancels a running task cooperatively"; `local-agent.test.ts` "cancels a run mid-turn, and the container is idle again" |
| A task that ignores the cancel | `runtime.test.ts` "kills the whole process group of a task that ignores its cancel" |
| The container is stopped mid-task | `agentforge-runtime.test.ts`, `deployed-agent.test.ts` "…runs the retry as the next attempt"; `runtime.test.ts` (the store's derivation) |
| The task process crashes | `runtime.test.ts` "records a crash with the tail of its stderr" |
| Busy while a task runs | `runtime.test.ts` "reports busy on /ping while a task runs"; ⚠ that a task never delays the report is by design, not tested |

### client-task-calls

| Scenario | Covered by |
|---|---|
| A typed output | `local-agent.test.ts`; `runtime.test.ts`; compile-time typing by the examples' `typecheck` |
| An output the caller's contract refuses | ⚠ none |
| A new session is provisioning | `src/client/transport.test.ts` "repeats a call AgentCore refuses…", "throws the refusal once the budget is spent"; `agentforge-runtime.test.ts` "answers calls that overlap the first to a new session" |
| Any other failure | `transport.test.ts` "throws any other AgentCore error at once, with AgentCore's code" |
| A typed output, heartbeating | `examples/hello-agent/e2e/local/temporal-activity.test.ts` "returns the typed output, heartbeating the task as it runs" |
| A cancelled activity | `temporal-activity.test.ts` "cancels its task when the activity is cancelled" |
| A failure's retry guidance | ⚠ none; ⚠ a rejection is retried |

### runtime-observability

| Scenario | Covered by |
|---|---|
| The consumer chooses the detail | `src/server/runtime/telemetry.test.ts` "exports metrics and events at WARN…", "adds traces at INFO, content at DEBUG and raw bodies at ALL"; `src/infra/agent-runtime.test.ts` "exports the telemetry level the consumer chooses" |
| An unknown level | `telemetry.test.ts` "refuses a level it does not know" |
| Runs read as GenAI operations | ⚠ none — the mapping lives in the collector's configuration; flushing before the container goes away is also untested |
| A lost task is counted once | `runtime.test.ts` "derives a task lost once its lease lapses, counts it once…"; ⚠ the other three counts are not asserted |
| One dashboard per agent | `agent-runtime.test.ts` "counts per agent under its runtime name, may publish only to its namespace, and charts it beside AgentCore" |
| A count that cannot be published | `src/server/runtime/metrics.test.ts` "logs a count it could not publish as an error, and still settles" |

### infra-agent-runtime

| Scenario | Covered by |
|---|---|
| A deploy that returns serves | `agentforge-runtime.test.ts` (deploys through `AgentRuntime`, then runs a procedure); `agent-runtime.test.ts` "probes the runtime at every new version, with leave to invoke it" |
| Containers restored from one image mint distinct ids | `agentforge-runtime.test.ts` "mints distinct ids in containers restored from one snapshot" |
| What the construct owns | `agent-runtime.test.ts` "refuses a table name the consumer set, which the construct owns" |
| Declared secrets alone | `agent-runtime.test.ts` "names its declared secrets to the server, and may read those alone"; `src/server/runtime/secrets.test.ts` "reads each declared secret into the environment variable it names" |
| A secret also set as a plain value | `agent-runtime.test.ts` "refuses a secret also set as a plain variable" |
| A caller granted one agent | ⚠ none — `grantInvoke` is not tested |
| The default retention | `agent-runtime.test.ts` "persists session transcripts in a private, encrypted, versioned bucket…, expired after 30 days"; ⚠ TLS-only is not asserted |
| A chosen retention | `agent-runtime.test.ts` "keeps transcripts as long as the consumer chooses" |
| Two agents share a store | `src/infra/s3-filesystem-bucket.test.ts` "is a private, S3-encrypted, versioned, retained bucket that several agents share"; `agent-runtime.test.ts` "names its filesystem buckets to the harness, and may read and write each"; `deployed-agent.test.ts` "keeps a note in an S3 filesystem…" |
| A store a sync could not verify | `s3-filesystem-bucket.test.ts` "refuses an encryption whose ETags are not MD5s" |

## Gaps

Scenarios with no test: an outcome too large; credentials kept out of the record; a store-reported mirror failure; a running continuity key; an output the caller's contract refuses; a failure's retry guidance in the activity; the GenAI mapping and flush; three of the four counts; `grantInvoke`. Partial: `/server`'s condition, the usage limit's reset time, TLS-only transcripts. All but the GenAI mapping are cheap unit tests; whether A4 writes them is the operator's.
