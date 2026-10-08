# Design

## Context

See proposal.md — Why. What holds today:

- **The package.** `libs/agentforge` is the one publishing project. Its `bundle` target (tsdown, then publint with `--pack npm`) writes the published package to `dist/libs/agentforge/bundle/`, copying non-code files it ships through `copy`: the README, the Dockerfile, the readiness probe, the collector's configuration, the container workspace, and the Nx plugin's manifests and schemas.
- **How the package resolves.** In this workspace, `node_modules/@beruangai/agentforge` links to `libs/agentforge`, the source. A consumer links the package with `bun link` until it is published (ROADMAP A7–A8).
- **The research** (`docs/research/claude-code-plugin-distribution.md`, spiked 2026-10-01 on CLI 2.1.284):
  - A `directory` marketplace loads its plugins in place, so an edit reaches the next session.
  - A marketplace registered at user scope with `enabledPlugins: { "agentforge@agentforge": false }` beside it, and enabled by a project's `.claude/settings.json` or `.claude/settings.local.json`, loads in that project only. This held on a fresh config directory in a headless session, with no install step and no trust prompt.
  - A marketplace declared only in project settings is invisible until an interactive trust step.
- **What a consumer's Claude Code can read.** The installed package — the bundle, with its README — not AgentForge's `docs/`, ADRs or root README.
- **The test tiers** (`.claude/rules/testing.md`):
  - unit tests are `src/**/*.test.ts`;
  - `integ` dimensions are folders, `model` being the one with the subscription token.

## Goals / Non-Goals

**Goals:**
- A consumer's Claude Code, in a project that enables the plugin, has one skill that tells it how to develop with AgentForge, from the version installed.
- The guide never names a file the installed package does not have.
- Registration and loading are tested where the platform could change them.

**Non-Goals:** as in proposal.md. Also: no test of what a model does with the skill. Whether Claude Code follows the guide well is judged by the operator using it, not asserted.

## Decisions

### The package root is the marketplace; the plugin is a concept folder

```
libs/agentforge/
  .claude-plugin/marketplace.json     the marketplace "agentforge", owner AgentForge
  claude-plugin/                      the plugin "agentforge"
    .claude-plugin/plugin.json
    skills/agentforge/
      SKILL.md                        the guide: when it applies, the loop, where to read on
      references/
        implementing.md               a procedure: contract, options, context, runs, guards,
                                      filesystems, memory, distill, side effects and `.then`
        consuming.md                  the client, `awaitTask`, workflow projects and connections
        operating.md                  targets, credentials per target, serve, e2e, deploy, limits
        migrations.md                 one entry per breaking version, newest first
    plugin-guidance.test.ts           the manifests, the skill's frontmatter and its links
```

```json
// .claude-plugin/marketplace.json
{
  "name": "agentforge",
  "owner": { "name": "AgentForge" },
  "plugins": [
    { "name": "agentforge", "source": "./claude-plugin", "description": "Developing agentic projects with AgentForge" }
  ]
}
```

- **The marketplace is the package root.** So the directory a developer registers is the installed package itself, `node_modules/@beruangai/agentforge`, wherever it resolves.
  - In this workspace that is the source, so an edit reaches the next session.
  - For a consumer it is the linked or installed bundle.
- **`claude-plugin/` is the plugin's concept folder,** holding its files and its test. It sits beside `src/` rather than in it, because its relative layout must be identical in the source and in the bundle, and `src/` is not copied whole.
- **The bundle copies `.claude-plugin/` and `claude-plugin/` with their layout,** test excluded. `publint --pack npm` already checks what the published package holds.
- **The skill is the practice; the package README is the reference.**
  - `SKILL.md` stays short: when the skill applies, the loop (adopt → generate → define → implement → consume → run), and which reference to read for each step.
  - The references hold the practice — what to write, in what order, and what is the consumer's.
  - Each reference links the package README (`../../../../README.md` from a reference) for what the plugin generates, maintains and lets the consumer detach, rather than restating it.
  - The root README stays the short overview, and links the skill for the guide.
- **Side effects are code.**
  - The guide shows a side effect after a successful run as the procedure's own code chained on the run: `context.runAgent(…).then((run) => …)`, or after `await`.
  - It never shows an `onSuccess` hook, which AgentForge does not have (§REQ205).
  - Recovery from a partial side effect is the consumer's, told by `attempt` and `priorAttempt`.

*Alternative:* the skill symlinked into each project's `.claude/skills/` from `node_modules`, which the research found needs no registration and works headless. The operator chose the plugin: the guide is for a developer's interactive Claude Code, where a one-time trust step costs nothing, and a plugin can grow commands, agents and hooks under one namespace. Recorded as proposed [ADR 0019](../../../adr/0019-claude-code-guidance-ships-as-a-plugin-in-the-package.md).

### Registration is documented, not generated

The package README gains "Claude Code plugin":

```bash
claude plugin marketplace add <workspace>/node_modules/@beruangai/agentforge --scope user
```

Then, in the user settings, `enabledPlugins: { "agentforge@agentforge": false }`. A project enables it with `"agentforge@agentforge": true` in `.claude/settings.json`, to share it, or `.claude/settings.local.json`, to keep it to one developer.

- **No generator writes either.**
  - Registration names a machine-local path, so it cannot live in a committed file.
  - Which settings file enables the plugin is the project's choice.
  - `init` would otherwise write a key into a file the consumer owns, for one line of setup.
- **This repository commits `"agentforge@agentforge": true`** in `.claude/settings.json`, beside the plugins it already enables, so its sessions use the guide a consumer gets. The operator registers the marketplace once on this machine, from this workspace's `node_modules/@beruangai/agentforge`.

### Migrations are an entry per breaking version, written by the change that breaks

`references/migrations.md` holds one section per version that changes what a consumer wrote or runs, newest first. Each section has:
- what breaks;
- what to change, as steps Claude Code can apply;
- how to verify (`nx sync`, the project's targets).

- **Until the package is published (A8),** there is no version to name: entries are headed by the AgentForge milestone and date.
- **The first entry is A6's breaking changes:**
  - contracts are strict or loose;
  - an agent construct takes its project's resources;
  - a task carries `image`;
  - the image is Debian.
- **The standing rule** goes in `CLAUDE.md` (Working rules): a change to what a consumer writes or runs updates the skill, and a breaking one adds its migration entry, in the same change.

### §REQ712, in the adoption category

> **REQ712** — A consumer's Claude Code is guided in developing with AgentForge by guidance that ships with the installed package and stays current with it.

It sits beside §REQ709 (adoption without wiring by hand), whose generated seams it explains.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| A manifest malformed, or naming a path that is not there | unit test | fails, naming the file |
| The skill links a file the package does not ship | unit test | fails, naming the link |
| The bundle omits the marketplace or the plugin | `bundle` | publint and the bundle's own check fail |
| The marketplace not registered on a machine | session start | the plugin is absent; the README's registration step says so. Claude Code reports a project enabling an unknown plugin |
| A consumer's `node_modules` path moves after registration | session start | the marketplace is unresolved; the developer registers it again |

## What earns which test

- **Unit** (`claude-plugin/plugin-guidance.test.ts`, run by the `test` target):
  - both manifests parse, name `agentforge`, and the marketplace's source is the plugin directory;
  - `SKILL.md`'s frontmatter has its `name` and a `description`;
  - every relative link in the skill and its references resolves inside the package.
- **Integration, `model`** (`integ/model/claude-plugin/`): registering at user scope with the plugin disabled there, and enabling it in a fixture project's settings, loads the skill in that project's session and not in a project that does not enable it.
  - This is AgentForge relying on platform behaviour the research spiked, which a CLI release can change.
  - It reads the session's `init` and needs no inference beyond it.
  - It runs against the bundle, so it also proves the published layout.
- **Settled once:** that a directory marketplace loads in place is documented and spiked (research note); no test.
- **Operator check:** with the marketplace registered on this machine, a session in this repository lists the skill, and asked to add a procedure to an example agent, follows it.

## Risks / Trade-offs

- **[One marketplace per machine]** Every project on a machine gets the guidance of the install it was registered from. → Documented in the README. A developer working on two AgentForge versions re-registers when switching. Today there is one version.
- **[The guide drifts from the code]** → The standing rule ties it to the change that alters consumer-facing behaviour, and the unit test catches a dead link. Content accuracy is reviewed with each change, like the README.
- **[The skill duplicates the README]** → The skill holds practice and links the README for reference, so a fact about what the plugin generates is stated once.
- **[The trust step]** A project-declared marketplace needs an interactive trust prompt. → User-scope registration avoids it, and it is acceptable for IDE use either way.

## Migration Plan

None for code. On this machine, the operator registers the marketplace once, as the README says. StrategyFoundry's corrections doc gains how it enables the plugin, once this is delivered.
