# Proposal

## Why

A consumer develops its agentic projects with Claude Code. Today nothing tells that Claude Code how AgentForge is meant to be used:
- a generated project's seams;
- how a procedure composes its options, its context and its runs;
- what is the consumer's to own;
- how to take a new AgentForge version.

That knowledge lives in AgentForge's own docs, which a consumer's repository does not have. The operator agreed on 2026-10-01 to ship a Claude Code plugin in the package, spiked the route the same day (`docs/research/claude-code-plugin-distribution.md`), and scheduled it as A6's last change. It was then dropped from A6's list and found missing on 2026-10-08. It lands before StrategyFoundry aligns its docs with AgentForge, since it is part of how StrategyFoundry integrates.

## What Changes

- **The package ships a Claude Code plugin marketplace.**
  - Its root holds `.claude-plugin/marketplace.json`, the marketplace `agentforge`.
  - That marketplace lists one plugin, `agentforge`, at a relative path inside the package.
  - The plugin holds one skill, `agentforge`: the consumer's guide to developing with AgentForge.
  - The marketplace is in both the workspace package and the published bundle.
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

  The skill states the practice and links the package README for the reference, so what the plugin generates and maintains stays documented once.
- **Registration is the operator's decision of 2026-10-01.**
  - The marketplace is registered once per machine at user scope, from the installed package, with `enabledPlugins: { "agentforge@agentforge": false }` beside it.
  - A project enables the plugin with `true` in `.claude/settings.json` (committed) or `.claude/settings.local.json` (not).
  - The one-time interactive trust step is accepted: the plugin is for a developer's Claude Code, never the Agent SDK.
  - The plugin loads in place, so a new package version updates the guidance with no reinstall.
- **AgentForge's own repository enables the plugin,** so its own sessions — and the work on its examples — use the guide a consumer gets.
- **A new requirement, §REQ712:** a consumer's Claude Code is guided by guidance that ships with the installed package and stays current with it.
- **A proposed ADR 0019,** recording why the guidance is a plugin from a marketplace in the package rather than a skill symlinked into each project. The research favoured the symlink for headless use; the operator chose the plugin for IDE use.
- **A standing rule:** a change to what a consumer writes or runs updates the skill, and a breaking one adds a migration entry.

## Capabilities

### New Capabilities

- `claude-plugin-guidance`: the package ships a Claude Code plugin whose skill guides a consumer's development with AgentForge. It is registered once per machine, enabled per project, current with the installed package.

### Modified Capabilities

None. The Nx plugin's generators are unchanged: enabling the plugin is a project's own setting, in whichever file it chooses.

## Impact

- **Package:**
  - new files at its root: `.claude-plugin/marketplace.json`, and the plugin directory with its manifest, skill and references;
  - the bundle copies them, so the published package carries them.
  - No entry point, export or runtime code changes.
- **This repository:** `.claude/settings.json` enables `agentforge@agentforge`. The operator registers the marketplace once on this machine.
- **Docs:**
  - the package README gains how to register and enable the plugin;
  - the root README points to it;
  - ARCHITECTURE §8 lists the plugin among what the package ships;
  - GLOSSARY gains the term;
  - REQUIREMENTS gains §REQ712;
  - `CLAUDE.md` gains the standing rule;
  - ROADMAP closes A6.
- **StrategyFoundry:** its corrections doc gains how it enables the plugin, once this is delivered.
- **Requirements:** adds §REQ712; serves §REQ709, since a consumer adopts AgentForge and takes new versions without wiring by hand. Leaves none unmet.
- **Open options:** none.

## Non-goals

- Commands, agents, hooks or MCP servers in the plugin. The plugin can carry them later; today the guide is a skill.
- Per-project guidance versions. A machine's marketplace is one install, so every project on the machine gets the guidance of the AgentForge it was registered from (research, 2026-10-01). A project on another version re-registers from its own install.
- Guidance for the Agent SDK sessions AgentForge runs. Those compose their own `.claude/` from an agent's layers.
- Generating or registering the plugin from a generator. Registration is per machine, and the enabling setting is the project's choice of file.
- Publishing the package. That is A8; until then a consumer registers from its linked install.
