# Proposal

## Why

A consumer's agents need to persist and share artifacts beyond one container (§REQ401, §REQ403). ADR 0011 decided they persist by syncing to an object store rather than a mount. This change specifies that capability. The first build (`f489b71`) swapped the sync engine that A0 had chosen, `s7cmd`, for a hand-rolled one, which is why this change exists.

## What Changes

- **A working directory** is a bucket the consumer declares. Several agents can share it, each opening it by name.
- **A procedure opens a prefix of it**, which is pulled into a directory of the task's own. The prefix is the procedure's choice.
- **The sync has no default.** The procedure declares every part of it: pull, when to push, continuous pushes with a quiet period, deletes and exclusions. A higher layer's defaults are values the procedure spreads.
- **Deletes are contained.** They are allowed only with a pull and on a non-empty prefix, and never reach outside the opened prefix.
- **The outcome waits for a verified push.** A push that cannot be verified fails the task with a retryable cause, `WORKING_DIRECTORY_UNSYNCED`.
- **`s7cmd` does the sync** (A0's choice, `docs/research/working-directory-sync.md`). It is pinned by sha256 in the base image and replaces the hand-rolled engine.
- **Exclusions become regular expressions**, which is what `s7cmd` takes. **BREAKING**, but only for code that has not shipped.

## Capabilities

### New Capabilities
- `filesystem-working-directories`: declaring a working directory, opening a prefix, the sync declaration, and pushing before the outcome.

### Modified Capabilities
None. This is the first spec.

## Impact

- **Interfaces:** `TaskContext.openWorkingDirectory`, the `WorkingDirectory` construct, `AgentRuntime.workingDirectories`, and a new cause code on the A2A outcome. The capability belongs in the harness, because the task process owns the task's lifetime (ADR 0004).
- **Base image:** adds the `s7cmd` musl aarch64 binary, about 13 MB.
- **Tests:** `integ/aws/filesystem-s3-sync` returns, run against the base image as built. The requirements it serves are §REQ401 and §REQ403.
- **Open sections:** none depended on. §F is closed by this change.

## Non-goals

- Mounts (tabled, ADR 0011), and a git-backed working directory. TrendBot's needs are A4 and are either added then or owned by TrendBot.
- Coordinating concurrent tasks on one prefix. The consumer's workflows ensure it cannot happen.
- KMS encryption.
