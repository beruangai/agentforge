---
status: proposed
date: 2026-09-27
decision-makers: Jeremy Jonas
---

# Working directories sync a prefix per task, with `s7cmd`

## Context and Problem Statement

[ADR 0011](0011-state-persists-through-apis-not-mounts.md) decided that a working directory persists by syncing to an object store, under a strategy the consumer declares, flushed and verified before the outcome is published. What is the API, who owns the bucket, and what runs the sync?

## Considered Options

* **Bucket**: one per agent, owned by `AgentRuntime` — or its own `WorkingDirectory` construct, given to agents by name
* **Strategy defaults**: AgentForge's own — or none; the consumer declares every field
* **Sync**: `s7cmd`, chosen at A0 and spiked ([research](../docs/research/working-directory-sync.md)) — or a sync of our own on the AWS SDK

## Decision Outcome

* **A `WorkingDirectory` construct owns its bucket**, so several agents can share one. `AgentRuntime` takes `workingDirectories: { name: WorkingDirectory }`, grants read and write, and names the buckets to the harness. The bucket is private, TLS-only, S3-encrypted and retained by default. No KMS: checkov's KMS rules are skipped in config.
* **The procedure opens one**: `context.openWorkingDirectory({ name, prefix, sync })` pulls the prefix into a directory of the task's own and returns its path, which the procedure hands the agent (`additionalDirectories`). The prefix is the procedure's choice and bounds everything the sync reads, writes and deletes (§REQ401).
* **The strategy has no default of AgentForge's.** `sync` is declared whole:
  * `pull`
  * `push`: `NEVER`, `WHEN_COMPLETED` or `WHEN_ENDED`
  * `continuous`: off, or every N seconds leaving files changed in the last M seconds; only with `WHEN_ENDED`
  * `deletes`: only with `pull`, on a non-empty prefix
  * `exclude`: regular expressions

  A higher layer (the agentic project, the agent) declares its defaults as a value its procedures spread and override.
* **The outcome waits for the push.**
  * A completed task pushes its `WHEN_COMPLETED` and `WHEN_ENDED` directories; a failed task its `WHEN_ENDED` ones; a cancelled task nothing.
  * A completed task whose push fails ends `FAILED` with `WORKING_DIRECTORY_UNSYNCED`, retryable. A failed task keeps its own cause, with the sync's failure added to its message.
  * A failed pull fails the task the same way. The local copy is removed when the task ends.
* **`s7cmd sync` runs it**, as a child of the task process, so a cancel or a lost container takes it.
  * It verifies each transferred object's ETag and reports through exit codes, and any exit but 0 is unsynced.
  * A push compares by ETag, so an unchanged file is not uploaded again. `--delete` never removes an excluded object.
  * A continuous push's quiet period is `--filter-mtime-before`.
  * The binary is the static musl build, pinned by sha256 in the base image.
  * A sync of our own was rejected: it would re-implement the verification `s7cmd` already does.
* **Mechanics, not policy**: whether two tasks can push one prefix at once, and what a delete should remove, are the consumer's to prevent and to declare.

### Consequences

* Good, because a task never reports `TASK_STATE_COMPLETED` over files that did not arrive, and the verification is a mature engine's own
* Good, because the declaration sits in the consumer's code, beside the procedure that relies on it, with no hidden default
* Bad, because `s7cmd` is a personal project whose dependencies are updated best-effort; each release is admitted only through `integ/aws/filesystem-s3-sync`, and a sync of our own on the AWS SDK remains the fallback
* Bad, because a local run has no working directory unless the consumer names a bucket in `AGENTFORGE_WORKING_DIRECTORIES` and gives the container credentials
