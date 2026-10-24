---
status: proposed
date: 2026-10-24
decision-makers: Jeremy Jonas
---

# Git filesystems commit onto one branch, refuse a shared file, and keep their token from the agent

## Context and Problem Statement

A store with history is needed for StrategyFoundry's strategy artifacts, and S3 Files would need a VPC ([ADR 0011](0011-state-persists-through-apis-not-mounts.md)). [ADR 0015](0015-filesystems-mount-around-a-procedure.md) left git for later. A git filesystem needs answers ADR 0015's S3 kind did not:

* how a subtree of a repository becomes a mount's root;
* which branch;
* what happens when two writers push;
* how a remote is authenticated without the agent holding its credential;
* how partial work is kept without timer checkpoints.

## Considered Options

* **Subtree**:
  * git plumbing over a private git directory, with the mount as its work tree;
  * or a sparse checkout copied into the mount and back.
* **Branch**: one branch, `main` by default; or a branch per task, procedure or agent.
* **Two writers**:
  * refuse a push when a file it records was changed on the branch since its base;
  * or git's three-way merge, refusing only a textual conflict;
  * or rebase in a work tree, as TrendBot's predecessor does.
* **Token**:
  * held in the task process and passed to each git child's environment;
  * or written to git's global config, outside every working directory.
* **Partial work**:
  * a push the agent may call;
  * or timer checkpoints;
  * or none.

## Decision Outcome

* **Plumbing over a private git directory.**
  * A blobless clone of the branch lives outside the mount.
  * The mount's work tree is the subtree `<base>:<remotePath>`, read with its own index.
  * A push writes the work tree's changes in the write scope as a tree, splices it back under `<remotePath>`, and commits onto the base.
  * Merging onto a moved tip is `git merge-tree --write-tree` in memory, so a killed git child never leaves a rebase half done. Spiked on 2026-10-24 against git 2.47 ([research](../docs/research/git-filesystem.md)).
  * A copy in and out was rejected: it doubles the I/O and gives up git's own comparison.
* **One branch**, `main` unless the filesystem declares another; a consumer that wants another branch in development sets the option from a variable of its own.
  * Branches would need pull requests or merges downstream, which neither consumer wants.
  * TrendBot runs on one branch.
* **A file changed by both writers refuses the push** `FILESYSTEM_UNSYNCED`.
  * Disjoint changes merge, because a branch is one ref and every two pushers contend on it, whatever paths they touch.
  * Git's textual merge was rejected. It silently combines hunks of structured files — frontmatter, JSON, YAML — into something neither writer wrote.
  * Refusing the file is the nearest to S3's per-object semantics that never overwrites.
  * A retry pulls the new tip and starts again.
* **The token never reaches the agent.**
  * It is a declared secret, like any other.
  * The git kind removes it from the task process's environment when the filesystem is declared, before any run, and passes it to each of its own git children as `http.<host>.extraheader` through `GIT_CONFIG_*`.
  * It is never written to disk, a command line or a cause.
  * The global-config option was rejected because the read fence that would guard it covers only `claude`, may be turned off, and does not see `git config --global --list` run by an agent allowed `git`.
  * The task process's initial environment, kept under `/proc`, still holds it, as it holds every secret. The operator deferred [§ODO005](../docs/DESIGN_OPTIONS.md) again on that basis on 2026-10-24. Rotation stays manual.
* **The agent may push; there are no timer checkpoints.**
  * A git mount that pushes on `TASK_STATE_FAILED` offers a push, which each framework renders as one tool. It is gated on that state because a push mid-task publishes before the outcome.
  * Timer checkpoints were rejected because each would be a commit the agent did not choose.
  * Offering none was rejected: a kept local copy survives the task but not the container, which an idle timeout, `maxLifetime`, a deploy or a loss ends.
* **A repository is named, and the deployment maps the name** to a remote or, locally, a host repository the serve target mounts, as buckets are mapped. One code path everywhere (§REQ701).

### Consequences

* Good, because a push is one atomic commit, so a lost container never leaves half a push, and history makes a bad push recoverable.
* Good, because a delete is relative to the base: another writer's new file survives it.
* Bad, because two writers on one file never merge. The second retries, and its agent may redo work.
* Bad, because every agent image carries `git`, about 29 MB.
* Bad, because the initial environment of a task process stays readable in `/proc` to an agent with an unfenced shell. That is recorded, not mitigated, as for every secret (§ODO005).
