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

**Registered once per machine at user scope, enabled per project: the route AgentForge takes.**
- `claude plugin marketplace add <dir> --scope user` registers the marketplace in the user's settings, with its absolute path, which is per machine anyway. With `enabledPlugins: { "agentforge@agentforge": false }` beside it, no project gets the plugin.
- A project that sets `enabledPlugins: { "agentforge@agentforge": true }` in `.claude/settings.json` (committed) or `.claude/settings.local.json` (not) gets it. That held on a fresh config directory in a headless session, with no `install` step and no trust prompt.
- It loads in place: an edit to the marketplace directory reached the next session.
- The marketplace is one directory per machine, so every project on the machine gets the guidance of whichever AgentForge it points at, not each project's installed version.

**Re-checked 2026-10-08 on the SDK's CLI 2.1.280, from the repository root as the marketplace.**
- Registered at user scope with the plugin disabled there, a session started in a project that enables it lists `agentforge:agentforge` in its `initialize` response, and one in a project that does not, does not. This needs no credential and no turn (`integ/local/claude-plugin/`).
- `claude plugin validate` does not check that a relative plugin source exists: a marketplace naming `./no-such-plugin` passes. The registration test is what catches it.
