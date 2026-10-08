---
status: accepted
date: 2026-10-08
decision-makers: Jeremy Jonas
---

# Claude Code guidance ships as a plugin from the repository

## Context and Problem Statement

A consumer develops its agentic projects with Claude Code, which cannot see AgentForge's own docs. Guidance on developing with AgentForge has to reach that Claude Code (§REQ712) and stay current. How does it ship, and how does a project get it? The routes were spiked on 2026-10-01 ([research](../docs/research/claude-code-plugin-distribution.md)). Until AgentForge is published, a consumer installs it from an archive packed in a clone of this repository, so a developer has one on the machine.

## Considered Options

* **A plugin from a marketplace at the repository root**, registered once per machine from a local clone at user scope and disabled there, enabled per project in its settings
* **The same marketplace inside the published package**, registered from the installed package in `node_modules`
* **A skill symlinked into each project's `.claude/skills/`** from `node_modules`, committed as a relative link
* **A marketplace declared in each project's settings**, from a relative path

## Decision Outcome

Chosen option: **a plugin from a marketplace at the repository root, registered per machine from a local clone, enabled per project.** The repository root holds `.claude-plugin/marketplace.json`; the plugin is a folder beside it. A local clone is the one route — not the git host, not an installed package — so the plugin loads in place and the skill links the repository's own docs rather than restating them. The guidance is for a developer's interactive Claude Code, never for the Agent SDK sessions AgentForge runs.

### Consequences

* Good, because the package and its bundle are untouched: nothing is copied, and the guidance is maintained where it is read
* Good, because the clone loads in place, so a pull updates the next session, and a project installing AgentForge's archive from that clone runs the AgentForge the guidance describes
* Good, because the guidance is namespaced (`agentforge:`), and can grow commands, agents and hooks in the same plugin
* Good, because a project opts in with one setting, committed or local, and nothing is generated into it
* Bad, because a machine registers one clone, so every project on it gets that clone's guidance; the migrations reference carries a project built against an older AgentForge forward
* Bad, because registration is a manual step per machine

## Pros and Cons of the Options

### The marketplace inside the published package

* Good, because the registered directory is the installed version, once the package is published
* Bad, because the bundle copies the plugin, and it is registered from a path inside `node_modules` that moves with every reinstall
* Bad, because a plugin copied into the package cannot link the repository's docs, so it would restate them

### A skill symlinked into each project

* Good, because it needs nothing per machine, and loads in headless sessions with no trust step
* Bad, because it is a skill alone: no namespace, and no commands, agents or hooks beside it
* Bad, because it dangles until the package is installed where the link points

Headless loading was the reason to prefer it, and the guidance is never used headless.

### A marketplace declared in each project's settings

* Bad, because `claude plugin marketplace add --scope project` writes an absolute path, which cannot be committed for other machines
* Bad, because a project-declared marketplace is invisible to a fresh machine until an interactive trust step
