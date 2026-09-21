---
status: accepted
date: 2026-09-19
decision-makers: Jeremy Jonas
---

# A process per task, speaking JSON-RPC over a pipe

## Context and Problem Statement

AgentCore decides whether a session is alive from `/ping`, and a blocked `/ping` gets a busy session terminated — synchronous git spawns, backoff sleeps, and per-message logging once stalled it for seconds. Several tasks may run in one container at once, each with its own Claude CLI, shells, and MCP servers, and a cancelled task must leave nothing behind. Where does a task run relative to the server, and how do the two communicate?

## Considered Options

* **In the server's process** — least plumbing; relies on nothing in consumer code, middleware, or a tool ever blocking the event loop
* **A long-lived inner server** — a port, a readiness gate, a proxy, error tunnelling, and detecting a server that is alive but frozen
* **A process per task**, with the server spawning it

For the communication, given a process per task: **a JSON-RPC 2.0 stream over a dedicated pipe**, **the runtime's IPC channel**, or **files on disk**.

## Decision Outcome

Chosen option: **a process per task, speaking JSON-RPC 2.0 over a dedicated pipe** — one message per line.

* The process group is the unit of cancellation: `SIGTERM` for a graceful stop that flushes telemetry and records an outcome, then `SIGKILL` to the group, so no subprocess outlives its task. A cancel that arrives before the process exists is caught by a token set before the executor's first `await`
* The stream opens with a **protocol version** both sides must accept, because the executor ships in AgentForge's base image while the task process runs a consumer's build of the harness; a mismatch is refused before any work rather than surfacing as a decode error mid-task
* `run` and `cancel` go in; semantic status and artifact events and exactly one outcome come out, which the executor maps to A2A; the exit code is the backstop, and a process that exits without an outcome is recorded `failed` with its stderr tail
* A dedicated pipe rather than stdout, because a stray `console.log` from consumer code or a library would otherwise corrupt the protocol; stdout and stderr stay logs
* JSON-RPC rather than an ad-hoc frame or a runtime-specific IPC channel, because it is already the vocabulary at the outer boundary, it is trivially faked in tests, and it leaves a task process implementable in another language
* Each task loads its procedures at its start, from the image the container was deployed with
* The executor never knows what the process runs — Claude, or plain consumer code. That is what keeps the SDK out of the transport layer

### Consequences

* Good, because nothing a task does can stall `/ping`, and a task's leaks, subprocesses and crashes end with it
* Good, because the boundary is inspectable: a transcript of the pipe is the whole interaction
* Bad, because every task pays process start and module load, and the outcome must be serializable
