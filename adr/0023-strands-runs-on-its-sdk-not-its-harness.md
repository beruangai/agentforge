---
status: accepted
date: 2026-10-22
decision-makers: Jeremy Jonas
---

# Strands runs on its SDK, not its harness

## Context and Problem Statement

The `strands` framework ([ADR 0021](0021-an-agentic-project-chooses-its-framework.md)) drives a Strands agent loop inside a task. Strands ships two layers in TypeScript: `@strands-agents/sdk`, the agent loop with vended tools, plugins and interventions, and `@strands-agents/harness`, a batteries-included agent on top of it. The harness has the most built in, which is the reason for choosing Strands. Which does AgentForge build on?

## Considered Options

* **The SDK, with selected vended tools and plugins** (skills, files, shell, Cedar)
* **The harness**

## Decision Outcome

Chosen option: **the SDK, with selected vended tools and plugins.** The operator chose it on 2026-10-22.

* The harness was at 0.3.1 on 2026-10-22, first released 2026-09-21, and its minors break.
* Its defaults contradict AgentForge's rules, and each would need overriding:
  * subagents run in the background, against one outcome (§REQ206);
  * the model may background any tool;
  * the shell runs on the host with no isolation;
  * memory extraction runs in the background and is lost without `agent.shutdown()`;
  * it discovers `AGENTS.md` on its own, beside the layering AgentForge composes.
* The SDK's vended tools give a non-coding agent what it needs, under AgentForge's control.

**Revisit when** the harness reaches 1.0 and its defaults can be set to AgentForge's rules by configuration alone.

### Consequences

* Good, because every loop default is AgentForge's choice, and a stable 1.x package is what changes underneath.
* Bad, because AgentForge composes the tools, skills and instructions the harness would have given for free.
