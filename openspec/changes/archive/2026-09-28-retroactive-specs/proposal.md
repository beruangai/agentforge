# Proposal

## Why

A1 and A2 were built without OpenSpec, at the operator's choice: their behaviour is specified by `docs/ARCHITECTURE.md` and the tests. A3's `filesystem-lifecycle` is the one spec. A4 gives every built capability a spec, so the contract AgentForge offers its consumers is stated once, at its seams, and can be held against the code.

## What Changes

- Eight specs, retroactive: they state what is built, and change no behaviour.
- Each states what a consumer gets at the highest seam it touches, not how it is built: no providers, modules, constants or wire shapes unless the consumer sees them.
- Where the code falls short of a spec today, the audit in the same milestone raises it; the spec is not bent to the code.

## Capabilities

### New Capabilities
- `core-procedure-contract`: a contract a caller imports without agent code; a container refuses a contract it does not serve; an output is delivered only if it conforms (§REQ101, §REQ103, §REQ104).
- `harness-kernel-settlement`: an agent run returns the agent's first settled, structured answer or a typed cause; cancelling stops it; no guardrail is lost; every run is recorded without credentials (§REQ102, §REQ204, §REQ206, §REQ501, §REQ601, §REQ603).
- `harness-session-persistence`: a session resumes in any container of a deployed agent, and a run fails rather than leave a session that would not resume whole (§REQ402).
- `runtime-task-admission`: starting is asynchronous; an idempotency key names one logical execution; a start is refused, never queued (§REQ301, §REQ305, §REQ306).
- `runtime-task-execution`: one durable outcome; the time budget; a cancel stops everything; a lost task reported within a bounded time; a crash with its evidence; liveness never delayed (§REQ202, §REQ302, §REQ303, §REQ304, §REQ707).
- `client-task-calls`: calls typed by the caller's contract, one client for local and deployed agents, and the Temporal activity (§REQ101, §REQ301, §REQ503, §REQ701).
- `runtime-observability`: agent runs traced in the GenAI conventions at a level the consumer chooses; what AgentForge cannot rule out counted per agent on one dashboard (§REQ602, §REQ604).
- `infra-agent-runtime`: one construct deploys an agent that serves when the deploy returns; least privilege for the agent and its callers; private transcripts kept as long as the consumer chooses; filesystem storage shared across agents (§REQ402, §REQ705, §REQ706, §REQ707, §REQ708).

### Modified Capabilities
None.

## Impact

- `openspec/specs/` gains eight specs beside `filesystem-lifecycle`. No code, protocol or interface changes.
- Requirements with no spec here: §REQ201 (unknown options are not refused at run time — raised by the A4 audit), §REQ203, §REQ205, §REQ401, §REQ403, §REQ502, §REQ503's holding, §REQ702, §REQ704 — met by design or by the consumer, with no behaviour of AgentForge's to specify beyond the specs above.

## Non-goals

- The image chain and container workspace: build tooling the A5 generators replace; the e2e builds and runs it.
- The platform facts AgentForge's design rests on (capability composition, A2A version negotiation, AgentCore's provisioning and grace windows): they are research notes and integration tests, not AgentForge's behaviour.
- New tests for the gaps the coverage table names: flagged here, left to the operator.
