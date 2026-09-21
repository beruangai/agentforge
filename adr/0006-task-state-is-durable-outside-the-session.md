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

Chosen option: **a durable store outside the microVM, which is the A2A task store**, because the caller then reads state through the same contract it started the task with, and an outcome outlives every part of the system that produced it.

* **Writes are fenced, not merely serialized.** A2A's `TaskStore.save` overwrites unconditionally, so the store implementation carries the lease generation in the task's metadata and rejects a write from a stale holder — otherwise a container deriving `lost` and the original writing `succeeded` are two unordered writes and the later one wins
* The task process is not *given* store credentials, and a caller has none (T43); a child in the same microVM can still reach the execution role, so integrity rests on the microVM boundary
* Beyond A2A's own fields it keeps: the index by idempotency key that makes attaching possible ([ADR 0009](0009-the-caller-supplies-the-idempotency-key.md)), a **lease** the executor renews while the task process lives, the container instance, the attempt, and the outcome payload
* **Loss is derived at read time**: an unfinished task with a stale lease is lost. Nothing sweeps, so detection latency is the caller's poll interval, which is what a caller sizes its heartbeat against
* A large outcome payload is kept beside the record rather than inside it
* Which backing store, and its retention, are `docs/DESIGN_OPTIONS.md` §A and §H

### Consequences

* Good, because a caller's redeploy, a container kill, and an idle teardown all stop being data-loss events (H10, H11, T24, T25)
* Good, because idempotency and loss detection have one home rather than being spread across consumers
* Bad, because AgentForge now owns a stateful component, its schema, its retention, and its failure modes
