---
status: accepted
date: 2026-09-21
decision-makers: Jeremy Jonas
---

# Code ships in the image; images layer; only state is mounted

## Context and Problem Statement

Changing a prompt or a schema means changing code that runs in a container. In the predecessor harness that meant rebuilding one image serving every agent, so a one-line change to one procedure produced a new artifact for all of them. The instinct is to take code out of the image and mount it, so a change lands without a deploy. But a mount gives up versioning, and the cost of a deploy turns out not to be what it looked like. How is code delivered, and what is mounted?

## Considered Options

* **Code on a mount** — published separately, loaded per task, no image rebuild
* **Code fetched at task start** from an object store
* **Code in the image**, with image layers scoped so a change rebuilds only what contains it

## Decision Outcome

Chosen option: **code always ships in the image**, with layering as the mechanism that keeps a change from spreading, and mounts reserved for state.

* **A deploy does not interrupt anything.** AgentCore is explicit: "If you update your agent runtime with new code, existing sessions will continue using the previous version until they terminate and new sessions are created." There is no mid-turn churn to design around, so the argument for mounting code loses its strongest premise.
* **The base image carries the server and nothing else** — not the client, not the constructs, not the generators — so a change to any of those does not produce a new base image. The harness travels with a consumer's procedures instead, bundled from the package they depend on, which makes the executor and the task process independently versioned and the task protocol's version handshake load-bearing.
* **Layers, not mounts, are what decouple.** AgentForge vends a base image. A consumer extends it with a **agentic base image** — the skills, tools, MCP servers, prompt foundation and language runtimes a group of agents share, named for the project that vends it — and each **agent** image extends that with only its own procedures. A change then rebuilds the layer that contains it and the images above that layer, and nothing else. the predecessor harness's problem was that these layers were one layer.
* **Only if builds are deterministic.** An image digest changes if any byte does, so unaffected agents must rebuild to byte-identical images: pinned bases, reproducible bundler output, no timestamps, content-addressed tags, and `UpdateAgentRuntime` called only when the digest actually changed. Nx's affected graph decides what to rebuild; the digest decides what to update.
* **What is mounted is state** — the working directory, memory, transcripts — on S3 Files or EFS, which the documentation says a version update does not affect. Managed session storage is wiped by a version update and is therefore not where durable session state goes.
* **Local development builds the same image.** No mounted code, no hot reload: the only thing mounted locally is the state that is mounted in the cloud. A few seconds of rebuild is cheaper than a second code path, and over-engineering the development loop is how the predecessor harness drifted from what it ran in production.
* A task's record carries the artifact version that ran it, because a mixed-version fleet is normal while long sessions drain.
* **Identity is one triple, `{consumer}/{project}/{agent}`** — the registry path, the record, the telemetry. AWS resource names are generated rather than composed from it: `agentRuntimeName` is required, allows only letters, digits and underscores within 48 characters, and the construct generates it with CDK's `Names.uniqueResourceName`. A caller addresses an agent by the ARN its deployment exports.
* The contract hash guards the seam: a task whose hash the image does not implement is refused before any work ([ADR 0003](0003-procedures-are-type-safe-end-to-end.md)).

### Consequences

* Good, because code is versioned, immutable, rolled back as a unit, and signed by its digest — none of which a mount gives
* Good, because the VPC requirement, the 424 mount failure and the shared writable path stop being code-delivery risks; they remain only where a consumer chooses to mount state
* Good, because development and production run the same artifact, so "it worked locally" has one fewer cause
* Bad, because the edit-to-run loop is a build, push and update rather than a publish, and a change reaching the next run without an image rebuild is not supported — that ask was withdrawn, because layered images and affected-only rebuilds deploy only the agent that contains a change, and a deploy never interrupts a running session
* Bad, because byte-identical rebuilds are real work: a non-deterministic build silently reintroduces the churn this decision exists to prevent
