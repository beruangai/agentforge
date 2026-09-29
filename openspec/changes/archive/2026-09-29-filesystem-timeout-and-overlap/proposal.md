# Proposal

## Why

The A4 audit found two gaps between `filesystem-lifecycle` and the code. A task stopped at its time budget reaches the harness as a cancel, so a filesystem that pushes on `TASK_STATE_FAILED` never pushes on `TIMED_OUT`; the operator chose to state that a timeout pushes nothing, as a cancel does, and that checkpoints are what a timed-out task keeps. And nothing stopped two filesystems of one procedure from mounting at one local directory, or one inside the other, where one's removal races the other's push; the task now fails before anything is mounted.

## What Changes

- A timed-out task pushes nothing; its checkpoints are what persist (§REQ202, §REQ401).
- Two filesystems that share or nest a local path fail the task before anything is mounted.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `filesystem-lifecycle`: a timeout never pushes; overlapping mounts are refused.

## Impact

The harness already behaves this way (the timeout, by construction; the overlap, by the A4 fix). No interface changes.

## Non-goals

- Carrying the stop reason to the harness so a timeout can push — the operator chose against it.
