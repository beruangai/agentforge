---
status: proposed
date: 2026-09-27
decision-makers: Jeremy Jonas
---

# Working directories sync a prefix per task, verified by ETag

## Context and Problem Statement

[ADR 0011](0011-state-persists-through-apis-not-mounts.md) decided that a working directory persists by syncing to an object store, under a strategy the consumer declares, flushed and verified before the outcome is published. What is the API, who owns the bucket, and what does the sync run on?

## Considered Options

* **Bucket**: one per agent, owned by `AgentRuntime` — or its own `WorkingDirectory` construct, given to agents by name
* **Strategy defaults**: AgentForge's own — or none; the consumer declares every field
* **Sync**: `s3-sync-client` — or a minimal sync of our own on `@aws-sdk/client-s3`

## Decision Outcome

* **A `WorkingDirectory` construct owns its bucket**, so several agents can share one (TrendBot's vault is shared). `AgentRuntime` takes `workingDirectories: { name: WorkingDirectory }`, grants read and write, and names the buckets to the harness. The bucket is private, TLS-only and retained by default; its encryption is S3-managed and cannot be changed, because the sync verifies by ETag.
* **The procedure opens one**: `context.openWorkingDirectory({ name, prefix, sync })` pulls the prefix into a directory of the task's own and returns its path, which the procedure hands the agent (`additionalDirectories`). The prefix is the procedure's choice (§REQ401).
* **The strategy has no default of AgentForge's.** `sync` is whole: `pull`, `push` (`NEVER`, `WHEN_COMPLETED`, `WHEN_ENDED`), `continuous` (off, or every N seconds, only with `WHEN_ENDED`), `deletes`, `exclude`. A higher layer — the agentic project, the agent — declares its defaults as a value its procedures spread and override.
* **The outcome waits for the push.** A completed task pushes `WHEN_COMPLETED` and `WHEN_ENDED` directories; a failed one `WHEN_ENDED` only; a cancelled one nothing. A push uploads what differs by MD5, deletes what the task removed when `deletes`, then lists again and fails unless the prefix matches. A completed task whose push fails ends `FAILED` with `WORKING_DIRECTORY_UNSYNCED`, retryable; a failed one keeps its cause, the sync's failure added to its message. A pull that fails fails the task the same way. The local copy is removed when the task ends.
* **The sync is ours**, about 150 lines on the S3 client the session store already uses. `s3-sync-client` was last released in 2023 and pins a deprecated peer; what we need — list, compare, put, delete, relist — is small.
* **It runs in the task's process**, so a cancel or a lost container takes it; a continuous push's failure is logged, and only the push at the end decides the outcome.

### Consequences

* Good, because a task never reports `TASK_STATE_COMPLETED` over files that did not arrive, and the check is the bucket's own listing
* Good, because the declaration sits in the consumer's code, beside the procedure that relies on it, with no hidden default
* Bad, because two tasks pushing one prefix at once are last-writer-wins per file; the consumer serialises them, with a continuity key or by prefix
* Bad, because `deletes` without `pull` empties the prefix of everything the task did not write — the consumer's choice, as ADR 0011 says
* Bad, because a local run has no working directory unless the consumer names a bucket in `AGENTFORGE_WORKING_DIRECTORIES` and gives the container credentials
* Bad, because comparing by ETag rules out KMS encryption and multipart uploads; a file too large for one PutObject (5 GB) fails its push
