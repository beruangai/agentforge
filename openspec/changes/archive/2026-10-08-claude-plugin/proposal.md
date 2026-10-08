# Proposal

## Why

A consumer develops its agentic projects with Claude Code. Today nothing tells that Claude Code how AgentForge is meant to be used:
- a generated project's seams;
- how a procedure composes its options, its context and its runs;
- what is the consumer's to own;
- how to take a new AgentForge version.

That knowledge lives in AgentForge's own docs, which a consumer's repository does not have. The operator agreed on 2026-10-01 to ship a Claude Code plugin, spiked the route the same day (`docs/research/claude-code-plugin-distribution.md`), and scheduled it as A6's last change. It was then dropped from A6's list and found missing on 2026-10-08. It lands before StrategyFoundry aligns its docs with AgentForge, since it is part of how StrategyFoundry integrates.

## What Changes

- **The AgentForge repository is a Claude Code plugin marketplace.**
  - Its root holds `.claude-plugin/marketplace.json`: the marketplace `agentforge`, listing one plugin, `agentforge`, at `./claude-plugin`.
  - The plugin holds one skill, `agentforge`: the consumer's guide to developing with AgentForge.
  - The published package does not carry it. The marketplace is the repository, not the package.
- **Registration is the operator's decision of 2026-10-01, from a local clone only.**
  - A developer registers the marketplace once per machine at user scope, from a local clone of the repository, with `enabledPlugins: { "agentforge@agentforge": false }` beside it.
  - A local clone is the one route: not GitHub, not an installed package. A consumer has the clone anyway, since it links AgentForge from it with `bun link`.
  - A project enables the plugin with `true` in `.claude/settings.json` (committed) or `.claude/settings.local.json` (not).
  - The one-time interactive trust step is accepted: the plugin is for a developer's Claude Code, never the Agent SDK.
- **The guidance is current with the clone.** A local directory loads in place, so a pull updates the next session.
- **The skill guides a consumer's Claude Code through the whole loop:**
  - adopting AgentForge and generating projects, agents, workflow projects and connections;
  - defining a contract;
  - implementing a procedure:
    - its options;
    - its context;
    - stop guards;
    - several runs;
    - filesystems and memory;
    - `distill`;
    - side effects as code around `runAgent`, chained with `.then`, rather than an `onSuccess` hook;
  - consuming it from a client or a Temporal workflow;
  - serving, testing and deploying, with each target's credentials;
  - the known limits;
  - **migrating** from one AgentForge version to the next, from a migrations reference ordered newest first.

  The skill holds the practice and links the repository's own docs — the root README, the package README, ARCHITECTURE — for reference, rather than restating them. It loads in place from the clone, so those links resolve.
- **AgentForge's own repository enables the plugin,** so its own sessions — and the work on its examples — use the guide a consumer gets.
- **A new requirement, §REQ712:** a consumer's Claude Code is guided in developing with AgentForge by guidance AgentForge maintains and distributes, current with the developer's clone.
- **A proposed ADR 0019,** recording why the guidance is a plugin from a marketplace in the repository rather than a skill symlinked into each project. The research favoured the symlink for headless use; the operator chose the plugin for IDE use.
- **A standing rule:** a change to what a consumer writes or runs updates the skill, and a breaking one adds a migration entry.

## Capabilities

### New Capabilities

- `claude-plugin-guidance`: the AgentForge repository is a Claude Code marketplace whose plugin's skill guides a consumer's development with AgentForge. It is registered once per machine from a local clone, enabled per project, current with the clone.

### Modified Capabilities

None. The package and the Nx plugin's generators are unchanged: enabling the plugin is a project's own setting, in whichever file it chooses.

## Impact

- **Repository root:** new `.claude-plugin/marketplace.json` and `claude-plugin/`, with the plugin's manifest, skill and references. No package code, entry point, export or bundle changes.
- **Tests:** `libs/agentforge/integ/local/claude-plugin/`: the marketplace and plugin validate, every link in the skill resolves in the repository, and the registration route loads the skill only where a project enables it.
- **This repository:** `.claude/settings.json` enables `agentforge@agentforge`. The operator registers the marketplace once on this machine.
- **Docs:**
  - the root README gains how to register and enable the plugin;
  - the package README points to it;
  - ARCHITECTURE §8 lists the plugin in the repository layout;
  - GLOSSARY gains the term;
  - REQUIREMENTS gains §REQ712;
  - `CLAUDE.md` gains the standing rule;
  - ROADMAP closes A6.
- **StrategyFoundry:** its corrections doc gains how it enables the plugin, once this is delivered.
- **Requirements:** adds §REQ712; serves §REQ709, since a consumer adopts AgentForge and takes new versions without wiring by hand. Leaves none unmet.
- **Open options:** none.

## Non-goals

- Commands, agents, hooks or MCP servers in the plugin. The plugin can carry them later; today the guide is a skill.
- Guidance pinned to each project's installed version. A machine registers one clone, so every project on it gets that clone's guidance (research, 2026-10-01).
- Registering from GitHub or from an installed package. One route: a local clone.
- Guidance for the Agent SDK sessions AgentForge runs. Those compose their own `.claude/` from an agent's layers.
- Generating or registering the plugin from a generator. Registration is per machine, and the enabling setting is the project's choice of file.
