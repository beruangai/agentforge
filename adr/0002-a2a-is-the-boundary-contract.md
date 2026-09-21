---
status: accepted
date: 2026-09-19
decision-makers: Jeremy Jonas
---

# A2A is the contract between caller and runtime

## Context and Problem Statement

A Temporal activity starts an agent run in a container, follows it for minutes to hours, and sometimes cancels it. The run must not be bounded by one open connection: AgentCore caps a synchronous request at 15 minutes, a worker redeploy closes it, and a container that dies mid-run must still be accounted for. What contract carries this?

## Considered Options

* **A synchronous request held for the run** — the shape the first AgentForge had
* **Our own asynchronous envelope over AgentCore's HTTP protocol** — start, poll, fetch, all defined and maintained by us
* **A2A, through the official `@a2a-js/sdk`**, on AgentCore's A2A protocol

## Decision Outcome

Chosen option: **A2A**, because the task lifecycle it standardizes — submit, work, complete, fail, cancel, subscribe — is exactly the lifecycle we would otherwise invent, its SDK takes an injected task store, and AgentCore hosts the protocol natively. The specification defines a client as "an application or agent", so a Temporal activity is a first-class caller.

* Start is `SendMessage` with `returnImmediately`; the outcome is read by polling `GetTask`; cancellation is `CancelTask`. **Polling is the default, not a fallback**: streaming caps at 60 minutes and A2A has no replay across a reconnect, so a run of hours recovers only a task snapshot each time it reattaches
* The caller talks A2A and nothing else — no store credentials, no second endpoint. The client is caller-agnostic; Temporal is supported through an activity factory over it, never baked into the contract
* AgentForge still owns what A2A leaves open: durable state outside the microVM, the lease and loss, idempotency by a caller-supplied key ([ADR 0009](0009-the-caller-supplies-the-idempotency-key.md)), and the typed failure cause, which rides in a failed task's artifact
* **The SDK's request handler is wrapped, not used as-is.** It mints the task id and creates the event bus before the executor is reached, so attaching a retry to a running task, refusing an unknown contract hash, and admission control all have to happen in front of it
* The agent card is generated from the procedures a runtime serves; agent-to-agent discovery is not used, and costs nothing if it ever is
* What holds against the real platform is settled by spike (`docs/DESIGN_OPTIONS.md` §B, §I)

### Consequences

* Good, because the wire, its states, and its client are not ours to maintain, and an outcome never depends on a connection staying open
* Good, because the same server runs locally in Docker and on AgentCore
* Bad, because a short procedure pays a start-and-read round trip
* Bad, because AgentCore returns real HTTP statuses where A2A expects 200, the SDK mints ids with uuid4 against our uuid7 convention, and its card resolver cannot reach a card served through `InvokeAgentRuntime` — each has to be handled in the client
