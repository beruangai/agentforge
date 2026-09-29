# Tasks

## 1. Wire contract (first; everything else depends on it)
- [ ] 1.1 `core/`: the refusal reasons (`SERVICE_UNAVAILABLE`, `TOO_MANY_REQUESTS`), the refusals (`CONTAINER_STOPPING`, `ADMISSION_LIMIT`, `CONTINUITY_KEY_RUNNING`), the `agentforge` ErrorInfo domain and a Zod schema for the ErrorInfo, with unit tests

## 2. Server (after 1; parallel with 3)
- [ ] 2.1 An `A2AError` subclass whose `toErrorInfo()` carries the refusal; verify it answers HTTP 200 with `data: [ErrorInfo]` through the JSON-RPC handler
- [ ] 2.2 Executor: record each live task's start time; expose the continuity key's retry time; record a start refused as the stop began, by `startId`
- [ ] 2.3 Gateway: the three refusals thrown in-band before `sendMessage`, attach still first; after `sendMessage`, a raced stop becomes the refusal with no `bindKey`; one log line per refusal
- [ ] 2.4 Unit tests: each refusal with no `save` or `bindKey`; attach while full or stopping; the raced stop; the continuity retry time
- [ ] 2.5 `integ/local/runtime`: the admission-limit case asserts the in-band refusal; add a continuity case
- [ ] 2.6 `integ/aws/agentcore/agentforge-runtime.test.ts`: a continuity-key refusal reaches the caller intact through AgentCore

## 3. Client (after 1; parallel with 2)
- [ ] 3.1 Transport: parse `error.data`; an `agentforge` refusal throws `StartRefusedError` (a subclass of `AgentForgeRequestError`) with `refusal`, `retryAfterSeconds`, `retryAfter`; an ordinary `-32603` does not
- [ ] 3.2 Activity: wait out refusals within a 15-minute budget per attempt, heartbeating, ending on cancellation; past it, a retryable `ApplicationFailure` with `nextRetryDelay`
- [ ] 3.3 Unit tests for 3.1 and 3.2; `REJECTED` stays non-retryable
- [ ] 3.4 Verify the Temporal facts the docs state (attempts, `scheduleToCloseTimeout` with `nextRetryDelay`, fixed options) and record them in `docs/research/`

## 4. Docs (after 2 and 3)
- [ ] 4.1 ARCHITECTURE: the mechanical invariants, the `REJECTED` row, the start sequence; GLOSSARY: *refusal*, and the continuity key's entry; ADR 0007's "rejected loudly", mutated in place
- [ ] 4.2 `procedureActivity`'s doc comment and the README: the timeouts and attempts a caller sets
- [ ] 4.3 ROADMAP A4 progress

## 5. Verify
- [ ] 5.1 `nx run-many -t typecheck lint test` for the package and both examples
- [ ] 5.2 With the operator: `integ --configuration=local`, and `integ/aws/agentcore/agentforge-runtime.test.ts`
- [ ] 5.3 After the operator confirms: sync to `openspec/specs/` and archive
