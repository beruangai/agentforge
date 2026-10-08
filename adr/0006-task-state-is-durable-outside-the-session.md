---
status: accepted
date: 2026-09-19
decision-makers: Jeremy Jonas
---

# Task state is durable outside the runtime session

## Context and Problem Statement

A microVM is ephemeral: it dies mid-run, it is replaced, and it is torn down after idle. An outcome held only in it is lost with it, and a worker that was redeployed has nowhere to collect one from. A retry must be able to find the attempt it is retrying. A2A requires no persistence of a server, and its SDK's default task store is in memory. Where does a task's state live?

## Considered Options

* **In the container** — the A2A SDK's in-memory store; a restart loses every task
* **In the consumer's database** — each consumer implements state for its own tasks
* **In a store AgentForge owns, outside the microVM**, behind the A2A task store interface

## Decision Outcome

Chosen option: **DynamoDB, behind A2A's `TaskStore`**, because the caller then reads state through the same contract it started the task with, and an outcome outlives every part of the system that produced it.

* One table per agentic project, shared by its agents: a task item (the A2A task, its state, its agent, a lease), keyed by the task's id alone, and an idempotency-key item per agent pointing at that agent's latest attempt ([ADR 0009](0009-the-caller-supplies-the-idempotency-key.md)). Both expire after seven days. An agent's store reads another agent's task as absent and never writes it, so a request for one is answered not found. *(Amended 2026-10-08: the table was each agent's own. The operator chose one per project; its agents are trusted alike, and the table is not partitioned by agent in IAM, such as with `dynamodb:LeadingKeys` — the agent is a field on the task, not part of its key.)*
* **A terminal state is never replaced by a different one** — the write is conditional. That is the whole fencing: a loss derived by a reader and a late real outcome cannot both win, and whichever lands first stands
* **Loss is derived when read**: a live task whose 60-second lease has lapsed is written `LOST`. Nothing sweeps, so detection is bounded by the caller's poll interval plus the lease. The lease is long because a false `LOST` sends a consumer reconciling for nothing; a container stopped by the platform is killed within ~10 s, so a lost task is found within about a minute
* An outcome over 256 KB fails the task rather than being offloaded, so it always fits the task's item
* A caller has no store credentials; it reads through A2A (§REQ708). A task process could reach the execution role — integrity rests on the microVM boundary

### Consequences

* Good, because a caller's redeploy, a container kill and an idle teardown stop being data-loss events (§REQ302, §REQ303)
* Good, because idempotency and loss detection have one home
* Bad, because AgentForge owns a stateful component and its retention
