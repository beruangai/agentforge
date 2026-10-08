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
- **Registration is the operator's decision of 2026-10-01.**
  - A developer registers the marketplace once per machine at user scope, with `enabledPlugins: { "agentforge@agentforge": false }` beside it.
  - Today that is from a local checkout of the repository, which a consumer has anyway while it links AgentForge with `bun link`. Later it is from GitHub, `owner/repo#ref`, with no change to the marketplace.
  - A project enables the plugin with `true` in `.claude/settings.json` (committed) or `.claude/settings.local.json` (not).
  - The one-time interactive trust step is accepted: the plugin is for a developer's Claude Code, never the Agent SDK.
- **The guidance follows the source the machine registered.**
  - A local directory loads in place, so a pull of the checkout updates the next session.
  - A git source updates when the marketplace does.
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

  The skill is self-contained: it links only files inside the plugin, since a git-sourced marketplace copies the plugin alone. For what the plugin generates and maintains in the version a project actually runs, it points Claude Code at that project's installed package README.
- **AgentForge's own repository enables the plugin,** so its own sessions — and the work on its examples — use the guide a consumer gets.
- **A new requirement, §REQ712:** a consumer's Claude Code is guided in developing with AgentForge by guidance AgentForge maintains and distributes, current with the source the developer registered.
- **A proposed ADR 0019,** recording why the guidance is a plugin from a marketplace in the repository rather than a skill symlinked into each project. The research favoured the symlink for headless use; the operator chose the plugin for IDE use.
- **A standing rule:** a change to what a consumer writes or runs updates the skill, and a breaking one adds a migration entry.

## Capabilities

### New Capabilities

- `claude-plugin-guidance`: the AgentForge repository is a Claude Code marketplace whose plugin's skill guides a consumer's development with AgentForge. It is registered once per machine, enabled per project, current with the registered source.

### Modified Capabilities

None. The package and the Nx plugin's generators are unchanged: enabling the plugin is a project's own setting, in whichever file it chooses.

## Impact

- **Repository root:** new `.claude-plugin/marketplace.json` and `claude-plugin/`, with the plugin's manifest, skill and references. No package code, entry point, export or bundle changes.
- **Tests:** `libs/agentforge/integ/`:
  - `local`: the marketplace and plugin validate, and the skill's links stay inside the plugin;
  - `model`: the registration route loads the skill only where a project enables it.
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
- Guidance pinned to each project's installed version. A machine registers one source, so every project on it gets that source's guidance (research, 2026-10-01). The skill directs Claude Code to the project's own installed README for version-specific facts.
- Registering from GitHub. Supported by Claude Code with no change here, once the operator chooses to.
- Guidance for the Agent SDK sessions AgentForge runs. Those compose their own `.claude/` from an agent's layers.
- Generating or registering the plugin from a generator. Registration is per machine, and the enabling setting is the project's choice of file.
