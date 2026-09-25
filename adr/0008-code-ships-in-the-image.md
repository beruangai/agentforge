---
status: accepted
date: 2026-09-21
decision-makers: Jeremy Jonas
---

# Code ships in the image, and images layer

## Context and Problem Statement

Changing a prompt or a schema means changing code that runs in a container. In the predecessor harness that meant rebuilding one image serving every agent, so a one-line change to one procedure produced a new artifact for all of them. The instinct is to take code out of the image and mount it, so a change lands without a deploy. But a mount gives up versioning, and the cost of a deploy turns out not to be what it looked like. How is code delivered, and what is mounted?

## Considered Options

* **Code on a mount** — published separately, loaded per task, no image rebuild
* **Code fetched at task start** from an object store
* **Code in the image**, with image layers scoped so a change rebuilds only what contains it

## Decision Outcome

Chosen option: **code always ships in the image**, with layering as the mechanism that keeps a change from spreading.

* **A deploy does not interrupt anything.** AgentCore is explicit: "If you update your agent runtime with new code, existing sessions will continue using the previous version until they terminate and new sessions are created." There is no mid-turn churn to design around, so the argument for mounting code loses its strongest premise.
* **The base image carries what the Claude CLI needs and AgentForge itself**, as a member of one Bun workspace at `/workspace` whose root depends on the peers AgentForge's server and harness import, installed from a frozen lockfile. It is **built by the consumer** from the `Dockerfile` in `@beruangai/agentforge`; nothing is published as an image but the leaf agent. Each layer above adds its own workspace member and a lock of the whole workspace up to it, so it installs only what it adds. So the server and the harness come from one package version and cannot drift, every agent on a base runs the same AgentForge, every layer resolves a shared package to one copy, and an agent image is as thin as its own code. *(Amended 2026-09-25: the base previously carried nothing of AgentForge's, and each agent installed it from its own lockfile.)*
* **Layers, not mounts, are what decouple.** AgentForge vends a base image. A consumer extends it with a **agentic base image** — the skills, tools, MCP servers, prompt foundation and language runtimes a group of agents share, named for the project that vends it — and each **agent** image extends that with only its own procedures. A change then rebuilds the layer that contains it and the images above that layer, and nothing else. the predecessor harness's problem was that these layers were one layer.
* **Nx decides what is rebuilt, and that is the whole mechanism.** Each image is an Nx task depending on the task that bundles what it bakes in, so input hashing decides staleness and the graph decides order — which is what lets a local parent be named by a static tag. AgentForge builds no dependency graph, hashing or digest comparison of its own; an unaffected agent is never rebuilt, so byte-identity is not what keeps it from being redeployed.
* **State is not in the image** — the working directory, transcripts — and persists through APIs rather than a mount ([ADR 0011](0011-state-persists-through-apis-not-mounts.md)), so a version update does not touch it. Managed session storage is wiped by a version update and is therefore not where durable session state goes.
* **Local development builds the same image.** No mounted code, no hot reload, and nothing mounted at all, as in the cloud. A few seconds of rebuild is cheaper than a second code path, and over-engineering the development loop is how the predecessor harness drifted from what it ran in production.
* A task's record carries the artifact version that ran it, because a mixed-version fleet is normal while long sessions drain.
* **Identity is one triple, `{consumer}/{project}/{agent}`** — the registry path, the record, the telemetry. AWS resource names are generated rather than composed from it: `agentRuntimeName` is required, allows only letters, digits and underscores within 48 characters, and the construct generates it with CDK's `Names.uniqueResourceName`. A caller addresses an agent by the ARN its deployment exports.
* The contract hash guards the seam: a task whose hash the image does not implement is refused before any work ([ADR 0003](0003-procedures-are-type-safe-end-to-end.md)).

### Consequences

* Good, because code is versioned, immutable, rolled back as a unit, and signed by its digest — none of which a mount gives
* Good, because the VPC requirement, the 424 mount failure and the shared writable path are not code-delivery risks; they arise only where a consumer chooses to mount something itself
* Good, because development and production run the same artifact, so "it worked locally" has one fewer cause
* Bad, because the edit-to-run loop is a build, push and update rather than a publish, and a change reaching the next run without an image rebuild is not supported — that ask was withdrawn, because layered images and affected-only rebuilds deploy only the agent that contains a change, and a deploy never interrupts a running session
* Bad, because the whole scheme rests on every build going through the task graph. An image built by hand is outside it and can be stale or wrong, which AgentForge does not detect — the plugin makes the correct path the obvious one and does not police the other
