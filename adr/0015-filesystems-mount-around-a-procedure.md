---
status: accepted
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

* **A `Filesystem` is an abstract kind with two operations, `pull` and `push`.** The base class runs the lifecycle from the options the consumer declares, with the defaults below:
  * mount: resolve the scope, create the local directory, `pull`, start checkpoints. Every mount pulls, so a task works from what is in the store, never blind; a procedure that only adds a file scopes its `subpath` to it, and pulling again mid-task is an operation, not an option. A mount is AgentForge's copy into a local directory, not a runtime or container mount ([ADR 0011](0011-state-persists-through-apis-not-mounts.md))
  * unmount: stop checkpoints, push if `pushOn` lists the state the task ended in — `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, or both; a procedure's invocation is its task, so the filesystem uses A2A's task states and no terms of its own. A cancel never pushes, nor does a task stopped at its time budget — the harness is stopped the same way for both, so checkpoints are what a timed-out task keeps; a rejected task never mounts, and without `pushOn` nothing is pushed — then remove the local copy
  * checkpoints: a `push` every `intervalSeconds` of only the files unchanged for `settleSeconds`, so writes in progress settle first; only when `pushOn` includes `TASK_STATE_FAILED`, since they publish before the outcome is known

  Built in: `S3Filesystem` and `ScratchFilesystem`. A consumer subclasses for its own kind; git comes later.
* **Registration and lifecycle are separate.** `filesystems({ name: filesystem })` is oRPC middleware that only adds to a registry on the context: a name registered again replaces the entry upstream, and `replaceUpstream: true` drops everything upstream. The harness appends one middleware to the procedure it calls, which oRPC runs innermost — after every registration and before the handler — and mounts the registry. The harness unmounts once the outcome is known, so an output that fails validation counts as a failure.
* **Scope is per request, under two roots.** A filesystem declares a `localRoot`, absolute, and optionally a `remoteRoot`, absolute within its store (`/`, the whole store, by default): the static partitions its mounts live under. `scope({ input, context })` returns the `subpath`, relative and never climbing, and the `write` globs within it; the mount is `<localRoot>/<subpath>` locally and `<remoteRoot>/<subpath>` in the store, which a kind maps to its own addressing — S3 drops the leading slash for the key. Shared defaults are the options without `scope`, spread by each filesystem. A mount is readable whole; `write` is the whole mount by default when the filesystem pushes, and nothing when it does not — so read-only needs no declaration. A push never leaves the write scope.
* **The handler owns the agent's permissions.** `context.filesystems.<name>` gives each mount's `localPath` and baseline allow rules — `Read(//path/**)` and `Edit(//path/<write>)` — and `context.agentOptions` gives every mount as an additional directory and their rules as allowed tools, one set of run options a handler composes into a run's own, so a run fenced to its working directories reads its own mounts and no other. AgentForge applies none; procedures run in `dontAsk`, so a path without a rule is denied, and Bash is the procedure's own allow list.
* **A kind decides its `localRoot`**: `ScratchFilesystem` defaults to `<tmpdir>/agentforge-scratch/<name>` and mounts a directory per task under it, its subpath being the task id; `S3Filesystem` requires one, and prompts name its files through `context.filesystems.<name>.path()`. Two filesystems of one procedure never share or nest a resolved local directory: the task fails before anything is mounted.
* **One live task per local directory in a container.** A mount claims its local directory before creating it, in a registry in the container's temporary directory; while another live task holds that directory, or one around or inside it, the mount is refused `FILESYSTEM_UNSYNCED`, retryable, naming the holder, and the holder's files are untouched. The claim is released once the directory is removed; a dead process's claim is cleared.
* **The outcome waits for the push.** A completed task whose push fails ends `FAILED` with `FILESYSTEM_UNSYNCED`, retryable; a failed task keeps its own cause with the push's failure added. A failed pull fails the task before the handler runs.
* **An `S3FilesystemBucket` construct owns its bucket**, so several agents can share one; `AgentRuntime` takes `filesystems: { name: bucket }`, grants read and write, and names the buckets to the harness. The bucket is private, TLS-only, versioned, S3-encrypted and retained by default. No KMS; checkov's KMS and access-logging rules are the consumer's, in its config.
* **`s7cmd sync` runs S3**, as a child of the task process, so a cancel or a lost container takes it.
  * It verifies each transferred object's ETag, and any exit but 0 is unsynced. A push compares by ETag, so an unchanged file is not sent again; a checkpoint adds `--filter-mtime-before`.
  * One `--filter-exclude-regex` carries the consumer's `exclude` globs (converted, like the write scope), always a `..` segment, and everything outside the write scope; `--delete` never removes an excluded object. `dangerouslyEnableDeletes` is off by default: `--delete` removes every object in the write scope with no local file — anything written by someone else since the pull too, not only what the task removed — so a procedure enables it only for a case that needs it. It needs a remote root or subpath, so the resolved remote path is never `/`, and applies to the final push only, never a checkpoint. Deleting only what the task removed was rejected: S3 cannot check and delete atomically, so it would race the same way.
  * The binary is the static musl build, pinned by sha256 in the base image. A sync of our own was rejected: it would re-implement the verification `s7cmd` already does.
* **Mechanics, not policy**: two tasks on one prefix across containers, and what a delete should remove, are the consumer's to prevent (through `runtimeSessionId`, a continuity key, or a subpath per task) and to declare. The local directory is AgentForge's: a shared one is refused.

### Consequences

* Good, because a procedure's override is registered before anything is pulled, and the handler starts with its files present
* Good, because a task never reports `TASK_STATE_COMPLETED` over files that did not arrive, and the verification is a mature engine's own
* Good, because the handler sees every permission its agent gets, with no hidden wiring
* Bad, because `s7cmd` is a personal project whose dependencies are updated best-effort; each release is admitted only through `integ/aws/filesystem-s3-sync`, and a sync of our own on the AWS SDK remains the fallback
* Bad, because a local run has no S3 filesystem unless the consumer names a bucket in `AGENTFORGE_FILESYSTEM_BUCKETS` and gives the container credentials
