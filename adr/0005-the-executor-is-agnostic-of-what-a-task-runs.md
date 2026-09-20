---
status: proposed
date: 2026-09-19
decision-makers: Jeremy Jonas
---

# The executor is agnostic of what a task runs

## Context and Problem Statement

A task may run a Claude agent or plain consumer code with no agent (T4), and another agent framework is conceivable later. The pattern AgentCore documents pairs each framework with its own A2A executor — `StrandsA2AExecutor` for a Strands agent. Where does the difference between what tasks run belong?

## Considered Options

* **An executor per framework** — a Claude executor that calls the Agent SDK from the server process
* **An executor subclass per framework** — one generic executor, extended for Claude
* **One agnostic executor, and a run kind per procedure** — the difference lives inside the task process

## Decision Outcome

Chosen option: **one agnostic executor and a run kind per procedure**, because both alternatives put knowledge of Claude into layer 1 — the mixing [ADR 0001](0001-four-layers-with-contracts-at-the-boundaries.md) separates — and into the server process, across the boundary [ADR 0004](0004-a-process-per-task.md) draws.

* The executor, the wire, the task store, and the activity helper are identical for every run kind
* A procedure **has** a run kind — Claude or mechanical — which decides its run phase
* The shared interface is thin: input and an abort signal in, an outcome out. The Claude kind's content blocks, hooks, tools, permissions, structured output and settlement stay in its own interface, so the agent path gives up nothing to the mechanical one
* Outcomes have generic causes and per-kind causes; layer 1 reads only the kind and its retry guidance

### Consequences

* Good, because a procedure without an agent, or another framework later, is a run kind rather than a second executor, a second wire, or a second store
* Good, because the seam has two implementations from the start rather than being speculative
* Bad, because the procedure model splits into generic and Claude-specific parts, and every phase table must say which is which
