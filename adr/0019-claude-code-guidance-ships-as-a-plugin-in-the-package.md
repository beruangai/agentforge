---
status: proposed
date: 2026-10-01
decision-makers: Jeremy Jonas
---

# Claude Code guidance ships as a plugin in the package

## Context and Problem Statement

A consumer develops its agentic projects with Claude Code, which cannot see AgentForge's own docs. Guidance on developing with AgentForge has to reach that Claude Code (§REQ712), and stay current with the AgentForge version the project installs. How does it ship, and how does a project get it? The routes were spiked on 2026-10-01 ([research](../docs/research/claude-code-plugin-distribution.md)).

## Considered Options

* **A plugin from a `directory` marketplace in the package**, registered once per machine at user scope and disabled there, enabled per project in its settings
* **A skill symlinked into each project's `.claude/skills/`** from `node_modules`, committed as a relative link
* **A marketplace declared in each project's settings**, from a relative path

## Decision Outcome

Chosen option: **a plugin from a marketplace in the package, registered per machine, enabled per project.** The package root is the marketplace, so the directory registered is the installed package, and the plugin loads in place from it. The guidance is for a developer's interactive Claude Code, never for the Agent SDK sessions AgentForge runs.

### Consequences

* Good, because the guidance updates with the installed package, with no reinstall or version bump
* Good, because the guidance is namespaced (`agentforge:`), and can grow commands, agents and hooks in the same plugin
* Good, because a project opts in with one setting, committed or local, and nothing is generated into it
* Bad, because a machine registers one install, so every project on it gets that install's guidance; a developer on two AgentForge versions re-registers when switching
* Bad, because registration is a manual step per machine, needing an interactive trust step where it is not done at user scope

## Pros and Cons of the Options

### A skill symlinked into each project

* Good, because it needs nothing per machine, and loads in headless sessions with no trust step
* Bad, because it is a skill alone: no namespace, and no commands, agents or hooks beside it
* Bad, because it dangles until the package is installed where the link points

Headless loading was the reason to prefer it, and the guidance is never used headless.

### A marketplace declared in each project's settings

* Bad, because `claude plugin marketplace add --scope project` writes an absolute path, which cannot be committed for other machines
* Bad, because a project-declared marketplace is invisible to a fresh machine until an interactive trust step
