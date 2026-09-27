---
status: proposed
date: 2026-09-27
decision-makers: Jeremy Jonas
---

# Filesystems mount around a procedure; S3 syncs with `s7cmd`

## Context and Problem Statement

[ADR 0011](0011-state-persists-through-apis-not-mounts.md) decided that a filesystem persists by syncing to a store, as the consumer declares, and is verified before the outcome is published. Procedures also need scratch space that ends with the task, and TrendBot's vault will be git. What is the abstraction, where does its lifecycle run, who owns the bucket, and what syncs S3?

## Considered Options

* **Lifecycle**: the handler opens each filesystem — or middleware registers them and AgentForge mounts them around the leaf procedure
* **Bucket**: one per agent, owned by `AgentRuntime` — or its own construct, given to agents by name
* **S3 sync**: `s7cmd`, chosen at A0 and spiked ([research](../docs/research/working-directory-sync.md)) — or a sync of our own on the AWS SDK

## Decision Outcome

* **A `Filesystem` is an abstract kind with two operations, `pull` and `push`.** The base class runs the lifecycle from the options, which have no defaults of AgentForge's:
  * mount: resolve the scope, create the path, `pull`, start checkpoints. Every mount pulls, so a task works from what is in the store, never blind; a procedure that only adds a file scopes its `root` to it, and pulling again mid-task is an operation, not an option
  * unmount: stop checkpoints, `push` as `push` (`NEVER`, `WHEN_COMPLETED`, `WHEN_ENDED`) and the ending say — never after a cancel — then remove the local copy
  * checkpoints: a `push` every `intervalSeconds` of only the files unchanged for `settleSeconds`, so writes in progress settle first; only with `WHEN_ENDED`

  Built in: `S3Filesystem` and `ScratchFilesystem`. A consumer subclasses for its own kind; git comes later.
* **Registration and lifecycle are separate.** `filesystems({ name: filesystem })` is oRPC middleware that only adds to a registry on the context: a name registered again replaces the entry upstream, and `inherit: false` drops everything upstream. The harness appends one middleware to the procedure it calls, which oRPC runs innermost — after every registration and before the handler — and mounts the registry. The harness unmounts once the outcome is known, so an output that fails validation counts as a failure.
* **Scope is per request.** `scope({ input, context })` returns the subtree mounted (`root`) and the `read` and `write` globs within it, both the whole mount by default; `access` is `READ_ONLY` or `READ_WRITE`, and read-only has no write scope. A push never leaves the write scope.
* **The handler owns the agent's permissions.** `context.filesystems.<name>` gives each mount's path and baseline allow rules — `Read(//path/<read>)` and `Edit(//path/<write>)` — and `context.filesystemPermissions` merges them. AgentForge applies none; procedures run in `dontAsk`, so a path without a rule is denied, and Bash is the procedure's own allow list.
* **A kind decides its path**: `ScratchFilesystem` defaults to a directory of the task's own; `S3Filesystem` requires one, so prompts can name it.
* **The outcome waits for the push.** A completed task whose push fails ends `FAILED` with `FILESYSTEM_UNSYNCED`, retryable; a failed task keeps its own cause with the push's failure added. A failed pull fails the task before the handler runs.
* **An `S3FilesystemBucket` construct owns its bucket**, so several agents can share one; `AgentRuntime` takes `filesystems: { name: bucket }`, grants read and write, and names the buckets to the harness. The bucket is private, TLS-only, versioned, S3-encrypted and retained by default. No KMS; checkov's KMS and access-logging rules are the consumer's, in its config.
* **`s7cmd sync` runs S3**, as a child of the task process, so a cancel or a lost container takes it.
  * It verifies each transferred object's ETag, and any exit but 0 is unsynced. A push compares by ETag, so an unchanged file is not sent again; a checkpoint adds `--filter-mtime-before`.
  * One `--filter-exclude-regex` carries the consumer's `exclude`, always a `..` segment, and everything outside the write scope; `--delete` never removes an excluded object. `deletes` needs a non-empty root.
  * The binary is the static musl build, pinned by sha256 in the base image. A sync of our own was rejected: it would re-implement the verification `s7cmd` already does.
* **Mechanics, not policy**: two tasks on one path or prefix, and what a delete should remove, are the consumer's to prevent (through `runtimeSessionId`) and to declare.

### Consequences

* Good, because a procedure's override is registered before anything is pulled, and the handler starts with its files present
* Good, because a task never reports `TASK_STATE_COMPLETED` over files that did not arrive, and the verification is a mature engine's own
* Good, because the handler sees every permission its agent gets, with no hidden wiring
* Bad, because `s7cmd` is a personal project whose dependencies are updated best-effort; each release is admitted only through `integ/aws/filesystem-s3-sync`, and a sync of our own on the AWS SDK remains the fallback
* Bad, because a local run has no S3 filesystem unless the consumer names a bucket in `AGENTFORGE_FILESYSTEM_BUCKETS` and gives the container credentials
