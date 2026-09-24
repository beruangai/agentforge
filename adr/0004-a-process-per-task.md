---
status: accepted
date: 2026-09-19
decision-makers: Jeremy Jonas
---

# A process per task, over Node IPC

## Context and Problem Statement

AgentCore decides whether a session is alive from `/ping`, and a blocked `/ping` gets a busy session terminated — synchronous git spawns, backoff sleeps, and per-message logging once stalled it for seconds. Several tasks may run in one container at once, each with its own Claude CLI, shells and MCP servers, and a cancelled task must leave nothing behind. Where does a task run relative to the server, and how do the two talk?

## Considered Options

* **In the server's process** — least plumbing; relies on nothing in consumer code, middleware or a tool ever blocking the event loop
* **A long-lived inner server** — a port, a readiness gate, a proxy, and detecting a server that is alive but frozen
* **A process per task**, spawned by the server

For the channel, given a process per task: **JSON-RPC over a dedicated pipe on fd 3**, **the runtime's IPC channel**, or **files on disk**.

## Decision Outcome

Chosen option: **a process per task, over the runtime's IPC channel** (`stdio: [..., 'ipc']`, `serialization: 'json'`), in its own process group.

* In: `run` with the invocation, `cancel`. Out: a `record` per agent run, then exactly one `outcome`. A process that exits without an outcome failed, with the tail of its stderr
* The process group is the unit of cancellation: `cancel`, a grace, then `SIGKILL` to the group, so nothing a task started outlives it
* IPC rather than a hand-rolled pipe protocol: Bun and Node both provide it, it is already separate from stdout — a stray `console.log` cannot corrupt it — and it needs no framing, parsing or versioning of AgentForge's own. The executor and the task process come from one package version ([ADR 0008](0008-code-ships-in-the-image.md)), so the messages carry no protocol version
* The executor runs a command it is configured with and never knows what it runs; the consumer's task entry is where a harness meets its procedures

### Consequences

* Good, because nothing a task does can stall `/ping`, and a task's leaks, subprocesses and crashes end with it
* Good, because the channel is the platform's, not code AgentForge maintains
* Bad, because every task pays process start and module load (~65 ms measured), and the task process must be a Bun or Node process
