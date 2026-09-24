---
status: accepted
date: 2026-09-20
decision-makers: Jeremy Jonas
---

# The caller supplies the idempotency key; a task id is a wire handle

## Context and Problem Statement

A caller retries. Temporal times out an activity whose run is still going and schedules another attempt; a network error makes a client resend a start it already sent. Neither may start a second expensive agent run (§REQ305). A2A already carries two identifiers a caller can influence — the task id and the `contextId` — so a third field needs justifying.

## Considered Options

* **The task id is the key** — the caller mints it deterministically, from its own identity or a payload hash, including an attempt number so each attempt is its own task
* **`contextId` is the key** — the execution is the context, and the server finds the live task inside it
* **A separate key in the envelope**, stable across attempts, indexed by the server

## Decision Outcome

Chosen option: **a separate key**, because the server needs an index either way, and the other two each cost something the key does not.

* **A caller-minted task id works, but moves the lookup to the caller.** Attempt N has to find attempt N−1's live task, and an attempt that attached started no task of its own, so finding it is a walk rather than one probe. On AgentCore every probe is an invocation, and one against a stopped session provisions a microVM just to answer. It also makes the derivation rule part of the caller's contract, including an attempt number a non-Temporal caller may not have. The specification is also against it: "Client-provided `taskId` values for creating new tasks is **NOT** supported" (§3.4.2). `@a2a-js/sdk` accepts one in its code path but throws `TaskNotFoundError` when it names no stored task, so it cannot create a task under a caller's id anyway.
* **`contextId` collides with the Claude session.** A2A's context is a conversation, and ours is the transcript — a Claude session spanning several procedure calls would be split across contexts, inverting the protocol's own grouping. It is also the one grouping id the protocol lets a client own, so it stays the consumer's ([ADR 0007](0007-identity-is-the-consumers.md)). `ListTasks` filters by `contextId` and status but not by metadata, so overloading it would not even buy a protocol-level lookup for the general case.
* **The key is the caller's to derive.** The Temporal activity factory uses workflow and activity identity; another caller may hash a payload or use any other stable rule.
* **The task id stays what A2A makes it**: opaque, server-minted, naming one attempt on the wire. A new attempt carries its prior attempt — its task id, its state and, for a failure, its cause — in its metadata, and its handler receives it as `priorAttempt`.
* The index costs little: the store exists anyway for the lease and loss detection ([ADR 0006](0006-task-state-is-durable-outside-the-session.md)). Its insert is conditional, so two starts racing under one key cannot both admit.
* **Where it runs matters**: the A2A SDK mints the task id before the executor sees the request, so the lookup sits in a request handler wrapping the SDK's, not in the executor.

### Consequences

* Good, because a retry after a timeout attaches to the run still in progress instead of starting a second expensive one — the predecessor harness's actual failure, and the case cancel-then-retry cannot cover when the container is unreachable
* Good, because the caller needs no id arithmetic, no attempt number, and no memory of previous attempts
* Bad, because there are two identifiers where a reader expects one, and the difference has to be explained each time
* Bad, because the key's retention window bounds how long attaching works (`docs/DESIGN_OPTIONS.md` §H)
