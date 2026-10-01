# Shipping Claude Code guidance in the package — spiked 2026-10-01

How a consumer's Claude Code picks up skills AgentForge ships inside `@beruangai/agentforge`, so they update with the package. Read from [Create a marketplace](https://code.claude.com/docs/en/plugins/create-marketplace.md), [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference.md) and [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace.md). Then spiked on CLI 2.1.284 against a stand-in package under a consumer's `node_modules`, with an isolated `CLAUDE_CONFIG_DIR` per simulated machine and headless `claude -p` sessions.

**A plugin from a `directory` marketplace in `node_modules` loads in place, but registering it is per machine.**
- A marketplace added from a local directory loads plugins with relative-path sources from that directory. An edit to the package reached the next session with no version bump, as documented.
- `claude plugin marketplace add <dir> --scope project` writes the **absolute** path into `.claude/settings.json`, which cannot be committed for other machines.
- On a fresh config directory, a project-declared marketplace, relative or not, was invisible to `claude plugin` commands and to `-p` sessions. `install` fails with "not found in marketplace". Registering it needs the interactive folder-trust prompt, which a headless or SDK session does not grant.

**A skill symlinked into `.claude/skills/` from `node_modules` needs nothing per machine.**
- `.claude/skills/agentforge -> ../../node_modules/@beruangai/agentforge/<path>/skills/agentforge` is a relative, committable link. It loaded on a fresh config directory in a headless session with no install step.
- An edit to the package reached the next session.
- The link dangles until the package is installed, and the package must be installed where the link points (the workspace root's `node_modules`).
- What it gives up against a plugin: a namespace (`/agentforge:…`), and bundling agents, commands, hooks or MCP servers. Agents can be linked into `.claude/agents/` the same way.

**What AgentForge takes from this:** the guidance is for a consumer's interactive Claude Code, not the Agent SDK, so a plugin with a one-time trust prompt per machine is acceptable. The project settings must carry the marketplace's path relative to the repository, written by hand rather than by `marketplace add`. Whether the trust prompt resolves a relative `directory` path is not yet observed; it is checked interactively when the plugin is built.
