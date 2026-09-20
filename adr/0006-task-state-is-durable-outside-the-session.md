---
status: proposed
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

Chosen option: **a durable store outside the microVM, which is the A2A task store**, because the worker then reads state through the same contract it started the task with, and an outcome outlives every part of the system that produced it.

* **One writer**, the TaskExecutor. The task process holds no credentials for the store, and a caller holds none either (T43)
* Beyond A2A's own fields it keeps: the index by idempotency key that makes attaching possible ([ADR 0009](0009-the-caller-supplies-the-idempotency-key.md)), a **lease** the executor renews while the task process lives, the container instance, the attempt, and the outcome payload
* **Loss is derived, not reported**: an unfinished task with a stale lease is lost. A container finding a live task recorded in its own runtime session under a different instance records it lost at once, because a runtime session has one container
* A large outcome payload is kept beside the record rather than inside it
* Which backing store, and its retention, are `docs/DESIGN_OPTIONS.md` §A and §H

### Consequences

* Good, because a worker redeploy, a container kill, and an idle teardown all stop being data-loss events (H10, H11, T24, T25)
* Good, because idempotency and loss detection have one home rather than being spread across consumers
* Bad, because AgentForge now owns a stateful component, its schema, its retention, and its failure modes
