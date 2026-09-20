---
status: proposed
date: 2026-09-20
decision-makers: Jeremy Jonas
---

# Procedure code is a published bundle, not a baked image

## Context and Problem Statement

Changing a prompt or a schema in the first AgentForge means building and deploying a container image — minutes of turnaround for a one-line change, which is most changes. StrategyFoundry requires that a change reach the next run without an image rebuild (H22). Meanwhile the image carries slow-moving things: Bun, the Claude CLI, and a consumer's language runtimes. How is a runtime's code delivered?

## Considered Options

* **Baked into the image** — one artifact, rebuilt and redeployed for every change
* **Fetched at task start from an object store** — each task downloads before it runs
* **Published as a bundle on a mounted filesystem**, loaded by each task process at its start

## Decision Outcome

Chosen option: **a published bundle on a mount**, because a process per task already loads code at its start ([ADR 0004](0004-a-process-per-task.md)), so a mounted bundle needs no reload mechanism, no cache invalidation, and no restart.

* A **runtime** is an image, the bundle it serves, its card, and its stores; publishing a bundle makes it the next task's code
* The image stays the slow-moving part and is rebuilt when Bun, the CLI, or a consumer's runtime changes
* A baked bundle remains supported for a deployment that wants no mount; the loading path is the same
* The contract hash guards the seam: a task whose hash the loaded bundle does not implement is refused before any work ([ADR 0003](0003-procedures-are-type-safe-end-to-end.md))
* AgentForge ships the publish command and the CDK constructs for the bucket, the mount, and the runtime, so deployment and mount cannot drift apart
* The mount's limits and latency are `docs/DESIGN_OPTIONS.md` §D

### Consequences

* Good, because the edit-to-run loop is a publish, and a rollback is publishing the previous bundle
* Good, because the same mechanism serves local Docker, where the bundle is a mounted directory
* Bad, because two artifacts can drift: an image too old for the bundle it is asked to load, which the hash catches only per procedure
* Bad, because a bad publish reaches every task at once, so publishing needs the same care as a deploy
