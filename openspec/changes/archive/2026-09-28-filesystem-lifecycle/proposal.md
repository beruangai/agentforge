# Proposal

## Why

Procedures need file I/O that AgentForge manages (§REQ401, §REQ403). Some of it persists and is shared across sessions and agents: StrategyFoundry's S3 R&D workspace, TrendBot's git vault. Some of it is scratch space that ends with the task. The first build (`f489b71`, `2171e27`) modelled this as a single S3 "working directory" opened by the handler. That is one use of a more general capability, **Filesystem**, and it put the lifecycle in the wrong place.

## What Changes

- **Filesystem, an abstract capability.** A filesystem has a lifecycle (mount, then unmount) built from a small set of operations: pull, push, and checkpoints, which are periodic pushes of files that have stopped changing. Each kind implements those operations; the base class runs the lifecycle from the declared config.
- **Built-in kinds:**
  - `S3Filesystem`, on `s7cmd`, first.
  - `ScratchFilesystem`, ephemeral.
  - Git later. A consumer can subclass for its own kind.
- **Registered by an oRPC middleware into `context.filesystems`.**
  - An agentic project registers its defaults for every procedure; a procedure's own middleware adds to them.
  - Registering the same name downstream replaces that entry. Registering with `replaceUpstream: true` drops everything registered upstream.
- **Mounted around the leaf procedure.** AgentForge mounts every registered filesystem before the handler runs, and unmounts them once the outcome is known. The outcome is published only after the pushes it requires are verified.
- **Scope per request.** A callback on the request's input and context gives the subtree that is mounted, and the read and write scopes inside it. Read defaults to the whole mount; write does too when the filesystem pushes, and is empty when it does not, so read-only needs no declaration. A push never leaves the write scope.
- **The handler owns the agent's permissions.** Each mounted filesystem gives the handler its path and a baseline of permission rules for its scopes. The handler applies, extends or replaces them in its `runAgent` options. Nothing is wired into a run automatically.
- **Where it mounts:** each kind either sets a default path, which the consumer may override, or requires the consumer to give one.
- **BREAKING, for code not yet shipped:**
  - Removed: `openWorkingDirectory`, the `WorkingDirectory` construct and `AgentRuntime.workingDirectories`.
  - Replaced by: `S3FilesystemBucket` and `AgentRuntime.filesystems`.
  - Renamed: the cause code `WORKING_DIRECTORY_UNSYNCED` becomes `FILESYSTEM_UNSYNCED`.

## Capabilities

### New Capabilities
- `filesystem-lifecycle`: registering filesystems, mounting them around a procedure, scope and baseline permissions, syncing, and the outcome waiting for the push.

### Modified Capabilities
None.

## Impact

- **Interfaces:**
  - Harness: the `Filesystem` base class, the `filesystems()` middleware, and `context.filesystems`.
  - Infra: `S3FilesystemBucket` and `AgentRuntime.filesystems`.
  - Core: one cause code on the A2A outcome.
- **Where it lives:** the harness owns the lifecycle, because the task process owns the task (ADR 0004).
- **Base image:** keeps `s7cmd`.
- **Examples:** `hello-agent`'s notebook moves to `S3Filesystem` and verifies the baseline permissions end to end.
- **Checkov:** the consumer's bucket no longer suppresses `CKV_AWS_18` on the resource. That decision is left to the consumer's config.
- **ADR 0015** is rewritten to cover Filesystem.

## Non-goals

- Wiring permissions or directories into `runAgent`. That is the handler's job.
- Coordinating concurrent tasks on one path or prefix. Consumers control that through `runtimeSessionId`.
- Constraining Bash. The procedure's Bash allow list does that.
- Mounts (ADR 0011), a git kind (A4) and KMS.
