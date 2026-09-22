---
status: accepted
date: 2026-09-21
decision-makers: Jeremy Jonas
---

# State persists through APIs, not mounts

## Context and Problem Statement

A container is ephemeral, but a session must resume in another one (D17) and a consumer's artifacts must outlive the run that produced them. Mounting S3 Files answers both and is the shape AgentCore documents — but a bring-your-own filesystem requires VPC network mode, and that requirement is not small: private subnets with a NAT gateway for `api.anthropic.com`, four VPC endpoints to avoid paying NAT for ECR refreshes, subnets restricted to an allow-listed set of availability zones, mount targets aligned to those zones or invocations fail intermittently, paired security-group rules on 2049, DNS attributes enabled, no cross-account, ENIs that outlive a deleted agent by up to eight hours, a documented cold-start penalty, and every mount failure arriving as the same HTTP 424 a container kill produces. Is a mount the only way to persist state?

## Considered Options

* **S3 Files or EFS mount** — live, shared POSIX semantics; VPC required
* **`SessionStore` plus object-store sync, over HTTPS** — no mount, no VPC
* **Managed session storage** — no VPC, but per-session, capped, Preview, and wiped by a runtime version update

## Decision Outcome

Chosen option: **state persists through APIs**. No mount is required, so an agent runs in public network mode unless its consumer chooses otherwise.

* **Transcripts** persist through the SDK's `SessionStore` adapter, which is the documented pattern for ephemeral containers that hydrate on start. `CLAUDE_CODE_PROJECT_DIR_NAME` pins the project key, so resume does not depend on reproducing an identical working-directory path — and the key is namespaced by AgentForge, because one store serves many agents.
* **The rest of the config directory is baked into the image**: settings, skills, plugins and user-tier memory are capabilities, not state.
* **Working directories persist by syncing to an object store**, under a strategy the consumer declares per agent and may override per procedure — direction, delete propagation, continuous or at the close, cadence, exclusions. AgentForge runs it and guarantees the parts that are not a matter of taste: the sync is flushed and verified *before* the outcome is published, so a task never reports `SUCCEEDED` over unsynced files; it lives in the task's process group, so cancellation takes it; and its failure is an outcome, not a log line.
* **No mount is supported.** Neither consumer needs live shared POSIX — nothing reads another procedure's files mid-run, subtrees are megabytes, and nothing outside the agent writes to them — so mounts and the VPC they require are tabled rather than built. A consumer that wants one configures it in its own CDK.
* The mirror is best-effort by design, so AgentForge verifies rather than trusts: dedupe by entry id, check the transcript's last entry after the run, and fail the task on a dropped batch rather than logging it.

### Consequences

* Good, because no consumer pays for a VPC to run an agent, and the whole class of mount failures — AZ misalignment, 424s indistinguishable from container kills, ENI lifecycle — disappears from the default path
* Good, because local development uses the same mechanism: an object store is reachable from Docker, an S3 Files mount is not
* Good, because continuous sync makes a lost container lose seconds of work rather than a run's worth
* Bad, because a continuous strategy makes artifacts visible progressively rather than atomically, which is safe only while nothing reads another task's files mid-run — the reason the choice is the consumer's rather than ours
* Bad, because the declaration is real surface a mount would not need, and a wrong delete policy can empty a working directory the way a mount never would
* Bad, because a consumer that later needs live shared POSIX has to add a VPC and a mount itself, and AgentForge has no construct for it until one is asked for
