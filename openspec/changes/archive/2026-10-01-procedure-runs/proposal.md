# Proposal

## Why

A6 readies AgentForge for its first live consumer, and three things every procedure in TrendBot repeats are missing or unstated:

- **Several runs in one procedure.** A procedure often makes more than one agent run: a utility run that prepares context, or atomic work split into steps that do not warrant a workflow. It works today, but nothing states, tests or records it, and §REQ206 reads as one run per task.
- **Checks the agent fixes in its turn.** "The file I expect exists and is valid" is checked by hand after the run, where a failure can only fail the task (ROADMAP A6).
- **Context too large to send.** Context such as months of research files is distilled into a bounded block before a run.

## What Changes

- **A procedure may make any number of agent runs, or none, in its one process.** Each run settles on its own agent's last declared answer and is recorded. The task's outcome is what the procedure returns. §REQ206 is amended to say so; §REQ207 is new.
- **Structured output validated in the agent's turn** (§REQ208). Every structured output the agent submits is validated before it is accepted. The checks are the agent contract itself, always applied by AgentForge, plus any stop guards the run gives: callbacks that must all pass.
  - Every failing check goes back to the agent in one denial, in its turn, and the agent fixes everything it names and submits again. Batching matters because the attempts are limited.
  - The contract check catches what the JSON Schema the agent sees cannot express, such as `format` and refinements. Today those are found only after the run, with no retry.
  - Claude Code's structured-output retry limit bounds the attempts. Past it, the task fails `OUTPUT_INVALID` carrying the last reasons.
  - Validation runs on the agent's `StructuredOutput` submission, not at the SDK's `Stop` event. A `Stop` block after the submission changes nothing ([research](../../../docs/research/claude-agent-sdk.md), 2026-10-01).
- **Paths inside a mount.** A mounted filesystem resolves a path relative to its mount: one form refuses a path that climbs out, the other also refuses one outside the write scope. A procedure's own writes then cannot silently miss the push.
- **`distill`** (§REQ209). A procedure helper turns documents into one context block within a token cap.
  - Under the cap they pass through unchanged.
  - Over it, one utility run through the procedure's own `runAgent`, with no tools, compacts them with line citations.
  - A distillation well over the cap fails rather than passing on silently.

## Capabilities

### New Capabilities
- `harness-context-distillation`: distilling documents into a bounded context block before a run.

### Modified Capabilities
- `harness-kernel-settlement`: a procedure's runs each settle and are recorded on their own; the agent contract and stop guards hold structured output back in-turn.
- `filesystem-lifecycle`: the handler resolves paths inside a mount, refused outside it or its write scope.

## Impact

- **Requirements:** §REQ206 amended; §REQ207, §REQ208 and §REQ209 added to `docs/REQUIREMENTS.md`.
- **Agent entry** (`/agent`):
  - `AgentRunSpec` gains `guardrails.stop`;
  - `MountedFilesystem` gains `path` and `writablePath`;
  - `distill` and its types are new exports.
- **Kernel:** adds one `PreToolUse` hook of its own on the `StructuredOutput` submission to every run, checking the contract and any guards together. An exhausted retry limit's `OUTPUT_INVALID` now carries the CLI's reason instead of a fixed message.
- **Examples:** `golden-kata`'s writer guards its kata files; `smoke-coverage` gains a procedure that distills and then runs, so two runs are recorded on one task.
- **Tests:** a model `integ` slice for structured output validation, which AgentForge relies on and the SDK does not document.
- **No change** to the A2A contract, the task protocol or the runtime.

## Non-goals

- Mechanical procedures as a first-class kind. A procedure with no run is allowed, never special-cased.
- A separate "pure" kernel path. A utility run is the same `runAgent` with a minimal options preset, so it keeps cancellation and its record.
- Guard text in the prompt. AgentForge cannot render opaque callbacks; the procedure's prompt tells the agent what it must leave behind.
- File operations on a mount beyond resolving paths. A mount is a local directory, and `node:fs` reads and writes it.
- Caching distillations. A task process lives for one task.
- Auto memory and the Claude Code plugin: later A6 changes.
