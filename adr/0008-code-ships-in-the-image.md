---
status: accepted
date: 2026-09-21
decision-makers: Jeremy Jonas
---

# Code ships in the image; images layer; only state is mounted

## Context and Problem Statement

Changing a prompt or a schema means changing code that runs in a container. In the first AgentForge that meant rebuilding one image serving every agent, so a one-line change to one directive produced a new artifact for all of them. The instinct is to take code out of the image and mount it, so a change lands without a deploy. But a mount gives up versioning, and the cost of a deploy turns out not to be what it looked like. How is code delivered, and what is mounted?

## Considered Options

* **Code on a mount** — published separately, loaded per task, no image rebuild
* **Code fetched at task start** from an object store
* **Code in the image**, with image layers scoped so a change rebuilds only what contains it

## Decision Outcome

Chosen option: **code always ships in the image**, with layering as the mechanism that keeps a change from spreading, and mounts reserved for state.

* **A deploy does not interrupt anything.** AgentCore is explicit: "If you update your agent runtime with new code, existing sessions will continue using the previous version until they terminate and new sessions are created." There is no mid-turn churn to design around, so the argument for mounting code loses its strongest premise.
* **Layers, not mounts, are what decouple.** AgentForge vends a base image. A consumer extends it with a **package image** — the skills, tools, MCP servers, prompt foundation and language runtimes a group of agents share, named for the package that vends it — and each **agent** image extends that with only its own procedures. A change then rebuilds the layer that contains it and the images above that layer, and nothing else. The first AgentForge's problem was that these layers were one layer.
* **Only if builds are deterministic.** An image digest changes if any byte does, so unaffected agents must rebuild to byte-identical images: pinned bases, reproducible bundler output, no timestamps, content-addressed tags, and `UpdateAgentRuntime` called only when the digest actually changed. Nx's affected graph decides what to rebuild; the digest decides what to update.
* **What is mounted is state** — the working directory, memory, transcripts — on S3 Files or EFS, which the documentation says a version update does not affect. Managed session storage is wiped by a version update and is therefore not where durable session state goes.
* **Local development builds the same image.** No mounted code, no hot reload: the only thing mounted locally is the state that is mounted in the cloud. A few seconds of rebuild is cheaper than a second code path, and over-engineering the development loop is how the first AgentForge drifted from what it ran in production.
* A task's record carries the artifact version that ran it, because a mixed-version fleet is normal while long sessions drain.
* **Identity is one triple, `{consumer}/{package}/{agent}`** — the registry path, the record, the telemetry. AWS resource names are generated rather than composed from it: `agentRuntimeName` is required, allows only letters, digits and underscores within 48 characters, and the construct generates it with CDK's `Names.uniqueResourceName`. A caller addresses an agent by the ARN its deployment exports.
* The contract hash guards the seam: a task whose hash the image does not implement is refused before any work ([ADR 0003](0003-procedures-are-type-safe-end-to-end.md)).

### Consequences

* Good, because code is versioned, immutable, rolled back as a unit, and signed by its digest — none of which a mount gives
* Good, because the VPC requirement, the 424 mount failure and the shared writable path stop being code-delivery risks; they remain only where a consumer chooses to mount state
* Good, because development and production run the same artifact, so "it worked locally" has one fewer cause
* Bad, because the edit-to-run loop is a build, push and update rather than a publish, and StrategyFoundry's ask for a change to reach the next run without an image rebuild is not met (D27, withdrawn in `docs/CONSUMERS.md`)
* Bad, because byte-identical rebuilds are real work: a non-deterministic build silently reintroduces the churn this decision exists to prevent
