---
status: proposed
date: 2026-10-01
decision-makers: Jeremy Jonas
---

# AgentForge adds system-prompt fragments of its own, never the `claude_code` preset

## Context and Problem Statement

Some capabilities AgentForge gives a run work only when the agent is told how to use them. Auto memory (§REQ404) is the first: Claude Code loads `MEMORY.md` under any system prompt, but the model saves nothing unless it is told where its memory is and how to keep it ([research](../docs/research/claude-agent-sdk.md), 2026-10-01). Claude Code's own instructions for that are in its `claude_code` preset. Where do a run's instructions for an AgentForge capability come from?

## Considered Options

* **The `claude_code` preset**, with the procedure's prompt appended
* **Fragments of AgentForge's own**, appended to whatever system prompt the procedure gives, chosen from what the run declares
* **The procedure writes the instructions** into its own prompt

## Decision Outcome

Chosen option: **fragments of AgentForge's own.** The kernel holds a small registry of system-prompt fragments; each one says when a run calls for it, from what the run declares, and renders its text for that run. The kernel appends every fragment a run calls for after the procedure's own system prompt, in whatever form the procedure gave it. Auto memory is the first fragment, mirroring the substance of Claude Code's memory instructions, written for an agent whose task is not software development. A capability that needs a fragment refuses the preset, since the preset carries instructions of its own for the same thing.

### Consequences

* Good, because a procedure's system prompt stays its own: no software-engineering persona, tool etiquette or git guidance it did not ask for
* Good, because a capability and its instructions ship together, so a procedure cannot declare memory and forget to say how to use it, nor say it in a way the next release breaks
* Bad, because AgentForge maintains instructions that Claude Code also maintains, and they drift apart when Claude Code changes how memory works; the model integration test of saving and recalling is what notices
* Bad, because a procedure under the preset cannot use a capability that needs a fragment
