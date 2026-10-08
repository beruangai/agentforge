---
status: accepted
date: 2026-09-27
decision-makers: Jeremy Jonas
---

# State persists through APIs, not mounts

## Context and Problem Statement

A container is ephemeral, but a session must resume in another one (§REQ402) and a consumer's artifacts must outlive the run that produced them. Mounting S3 Files answers both and is the shape AgentCore documents — but a bring-your-own filesystem requires VPC network mode, and that requirement is not small: private subnets with a NAT gateway for `api.anthropic.com`, four VPC endpoints to avoid paying NAT for ECR refreshes, subnets restricted to an allow-listed set of availability zones, mount targets aligned to those zones or invocations fail intermittently, paired security-group rules on 2049, DNS attributes enabled, no cross-account, ENIs that outlive a deleted agent by up to eight hours, a documented cold-start penalty, and every mount failure arriving as the same HTTP 424 a container kill produces. Is a mount the only way to persist state?

## Considered Options

* **S3 Files or EFS mount** — live, shared POSIX semantics; VPC required
* **`SessionStore` plus object-store sync, over HTTPS** — no mount, no VPC
* **Managed session storage** — no VPC, but per-session, capped, Preview, and wiped by a runtime version update

## Decision Outcome

Chosen option: **state persists through APIs**. No mount is required, so an agent runs in public network mode unless its consumer chooses otherwise. **AgentForge owns the lifecycle of every filesystem it provides**: the session store always, as part of what the base image requires, and any filesystem a procedure registers.

* **Transcripts** persist through the SDK's `SessionStore` adapter, which is the documented pattern for ephemeral containers that hydrate on start, into the bucket its agentic project's agents share, each agent's under its own name, which its role alone may read and write. The project key is the SDK's own, from the working directory, beneath the agent's name; a resume therefore finds only the agent's own sessions, and uses the working directory its session began in — the agent's directory unless a procedure sets another. Pinning it with `CLAUDE_CODE_PROJECT_DIR_NAME` would also mean setting `CLAUDE_CONFIG_DIR`, for no need yet. *(Amended 2026-10-08: the bucket was each agent's own and needed no namespace; one per project, with the agent's name as the prefix, is the operator's choice.)*
* **The rest of the config directory is baked into the image**: settings, skills, plugins and user-tier memory are capabilities, not state.
* **Filesystems are an optional capability** a procedure registers so its agents can persist and share artifacts — StrategyFoundry's workspace and TrendBot's vault ([ADR 0015](0015-filesystems-mount-around-a-procedure.md)). They persist by syncing to an object store, under a strategy the consumer declares per agent and may override per procedure — direction, delete propagation, continuous or at the close, cadence, exclusions. AgentForge runs it and guarantees the parts that are not a matter of taste: the sync is flushed and verified *before* the outcome is published, so a task never reports `TASK_STATE_COMPLETED` over unsynced files; it lives in the task's process group, so cancellation takes it; and its failure is an outcome, not a log line.
* **No mount is supported.** Neither consumer needs live shared POSIX — nothing reads another procedure's files mid-run, subtrees are megabytes, and nothing outside the agent writes to them — so mounts and the VPC they require are tabled rather than built. A consumer that wants one configures it in its own CDK.
* The mirror is best-effort by design, so AgentForge verifies rather than trusts: dedupe by entry id, check that every assistant message the run streamed reached the store, and fail the task on a dropped batch rather than logging it.

### Consequences

* Good, because no consumer pays for a VPC to run an agent, and the whole class of mount failures — AZ misalignment, 424s indistinguishable from container kills, ENI lifecycle — disappears from the default path
* Good, because local development can use the same mechanism when a test needs it: an object store is reachable from Docker, an S3 Files mount is not
* Good, because continuous sync makes a lost container lose seconds of work rather than a run's worth
* Bad, because a continuous strategy makes artifacts visible progressively rather than atomically, which is safe only while nothing reads another task's files mid-run — the reason the choice is the consumer's rather than ours
* Bad, because the declaration is real surface a mount would not need, and a wrong delete policy can empty a filesystem the way a mount never would
* Bad, because a consumer that later needs live shared POSIX has to add a VPC and a mount itself, and AgentForge has no construct for it until one is asked for
