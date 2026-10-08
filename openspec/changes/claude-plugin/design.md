# Design

## Context

See proposal.md — Why. What holds today:

- **How a consumer reaches AgentForge.** Until the package is published (ROADMAP A7–A8), a consumer links it with `bun link`, so a developer has a clone of this repository on the machine. In this workspace, `node_modules/@beruangai/agentforge` links to `libs/agentforge`.
- **Claude Code's marketplaces** ([install](https://code.claude.com/docs/en/plugins/install), [marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference), read 2026-10-08):
  - A marketplace is a directory holding `.claude-plugin/marketplace.json`, its *root*. A plugin's relative source resolves from the root, starts with `./`, and may not contain `..`.
  - `claude plugin marketplace add <directory>` registers a local directory.
  - `claude plugin validate <path>` checks a marketplace root or a plugin. It does not check that a relative plugin source exists (CLI 2.1.280, 2026-10-08).
- **The research** (`docs/research/claude-code-plugin-distribution.md`, spiked 2026-10-01 on CLI 2.1.284):
  - A `directory` marketplace loads its plugins in place, so an edit reaches the next session.
  - A marketplace registered at user scope with `enabledPlugins: { "agentforge@agentforge": false }` beside it, and enabled by a project's `.claude/settings.json` or `.claude/settings.local.json`, loads in that project only. This held on a fresh config directory in a headless session, with no install step and no trust prompt.
- **The CLI the tests can run.** The Agent SDK ships the `claude` binary in its platform package (`@anthropic-ai/claude-agent-sdk-<platform>`), at the version AgentForge pins.
- **The test tiers** (`.claude/rules/testing.md`): `integ` dimensions are folders under `libs/agentforge/integ/`, and a concept goes in the folder of the most expensive thing it needs. `local` needs no credentials. A session's `initialize` response lists the skills it loaded with no turn and no credential (`integ/local/capability-composition/`), so registration needs nothing more than `local`.

## Goals / Non-Goals

**Goals:**
- A consumer's Claude Code, in a project that enables the plugin, has one skill that tells it how to develop with AgentForge.
- One route: a local clone, registered by path, loaded in place.
- The skill links the repository's docs rather than restating them, and every link resolves.
- Registration and loading are tested where the platform could change them.

**Non-Goals:** as in proposal.md. Also: no test of what a model does with the skill. Whether Claude Code follows the guide well is judged by the operator using it, not asserted.

## Decisions

### The repository root is the marketplace; the plugin is a root folder

```
<repository>/
  .claude-plugin/marketplace.json     the marketplace "agentforge"
  claude-plugin/                      the plugin "agentforge"
    .claude-plugin/plugin.json
    skills/agentforge/
      SKILL.md                        when it applies, the loop, which reference serves each step
      references/
        implementing.md               a procedure: contract, options, context, runs, guards,
                                      filesystems, memory, distill, side effects and `.then`
        consuming.md                  the client, `awaitTask`, workflow projects and connections
        operating.md                  targets, credentials per target, serve, e2e, deploy, limits
        migrations.md                 one entry per breaking change set, newest first
```

```json
// .claude-plugin/marketplace.json
{
  "name": "agentforge",
  "owner": { "name": "Jeremy Jonas" },
  "description": "Guidance for developing agentic projects with AgentForge",
  "plugins": [
    { "name": "agentforge", "source": "./claude-plugin", "description": "Developing agentic projects with AgentForge" }
  ]
}
```

- **The repository is the marketplace, registered from a local clone only.** Not from GitHub and not from an installed package: one route. The published package does not carry the plugin, so the bundle and publint are untouched.
- **`claude-plugin/` is a root folder,** not an Nx project and not under `libs/agentforge`. It holds no code, and it describes the whole of AgentForge rather than one concept of the package. Its checks live with AgentForge's integration tests (below).
- **The skill holds practice; the repository's docs hold reference.** The plugin loads in place from the clone, so the skill links the root README, the package README (`libs/agentforge/README.md`) and ARCHITECTURE by relative path, and Claude Code reads them there. The skill says what to write, in what order, and what is the consumer's; it does not restate what the generators produce or maintain.
- **Side effects are code.**
  - The guide shows a side effect after a successful run as the procedure's own code chained on the run: `context.runAgent(…).then((run) => …)`, or after `await`.
  - It never shows an `onSuccess` hook, which AgentForge does not have (§REQ205).
  - Recovery from a partial side effect is the consumer's, told by `attempt` and `priorAttempt`.

*Alternative:* the skill symlinked into each project's `.claude/skills/` from `node_modules`, which the research found needs no registration and works headless. The operator chose the plugin: the guide is for a developer's interactive Claude Code, and a plugin can grow commands, agents and hooks under one namespace. Recorded as proposed [ADR 0019](../../../adr/0019-claude-code-guidance-ships-as-a-plugin-from-the-repository.md).

### Registration is documented, not generated

The root README gains "Claude Code plugin":

```bash
claude plugin marketplace add <path to a clone of agentforge> --scope user
```

Then, in the user settings, `enabledPlugins: { "agentforge@agentforge": false }`. A project enables the plugin with `"agentforge@agentforge": true` in `.claude/settings.json`, to share it, or in `.claude/settings.local.json`, to keep it to one developer. The package README points to that section.

- **No generator writes either.**
  - Registration names a machine-local path.
  - Which settings file enables the plugin is the project's choice.
- **This repository commits `"agentforge@agentforge": true`** in `.claude/settings.json`, beside the plugins it already enables, so its sessions use the guide a consumer gets. The operator registers this clone once on this machine.

### Migrations are an entry per breaking change set, written by the change that breaks

`references/migrations.md` holds one section per change set that alters what a consumer wrote or runs, newest first. Each section has:
- what breaks;
- what to change, as steps Claude Code can apply;
- how to verify (`nx sync`, the project's targets).

- **Until the package is published (A8),** sections are headed by the AgentForge milestone and date; afterwards, by version.
- **The first entry is A6's breaking changes:**
  - contracts are strict or loose;
  - an agent construct takes its project's resources;
  - a task carries `image`;
  - the image is Debian.
- **The standing rule** goes in `CLAUDE.md` (Working rules): a change to what a consumer writes or runs updates the skill, and a breaking one adds its migration entry, in the same change.

### The checks run with AgentForge's local integration tests, on the CLI the SDK ships

`integ/local/claude-plugin/` runs the `claude` binary from the SDK's platform package, so it tests the CLI version AgentForge pins and needs nothing on `PATH` and no credentials. It sits in `local`, not the unit tier, because it shells out to the CLI.

- `claude plugin validate` passes on the repository root and on `claude-plugin/`.
- Every relative link in the skill and its references resolves to a file in the repository.
- In an isolated config directory, the marketplace is registered at user scope from the repository root, with the plugin disabled there. A fixture project that enables the plugin lists the skill in its session's `initialize` response; one that does not, does not. No turn is sent and no credential is present.

### §REQ712, in the adoption category

> **REQ712** — A consumer's Claude Code is guided in developing with AgentForge by guidance AgentForge maintains in its repository, current with the developer's clone.

It sits beside §REQ709 (adoption without wiring by hand), whose generated seams it explains.

## Error handling

| Failure | When | Outcome |
|---|---|---|
| A manifest malformed | `integ` local | `claude plugin validate` fails, naming the field |
| The marketplace's plugin source not there | `integ` local | the enabled fixture project does not list the skill (the validator does not check it) |
| The skill links a file that does not exist | `integ` local | fails, naming the link |
| The marketplace not registered on a machine | session start | the plugin is absent; the README's registration step says so |
| A registered clone moves | session start | the marketplace is unresolved; the developer registers it again |

## What earns which test

- **`integ` local, the manifests and links:** they validate and resolve. Cheap, and it catches what an edit breaks.
- **`integ` local, registration:** the route — user scope disabled, enabled per project — loads the skill only where a project enables it. AgentForge relies on this, the research spiked it, and a CLI release can change it.
- **Settled once:** that a directory marketplace loads in place is documented and spiked (research note); no test.
- **Operator check:** with this clone registered, a session in this repository lists the skill, and asked to add a procedure to an example agent, follows it.

## Risks / Trade-offs

- **[One clone per machine]** Every project on a machine gets the guidance of the clone it registered. A project linked with `bun link` runs that same clone, so they agree. → Migrations name the change set each entry belongs to, for a project built against an older AgentForge.
- **[The guide drifts from the code]** → The standing rule ties it to the change that alters consumer-facing behaviour, and the local check catches a dead link. Content accuracy is reviewed with each change, like the README.
- **[The skill duplicates the README]** → The skill holds practice and links the README for reference.

## Migration Plan

None for code. On this machine, the operator registers this clone once, as the README says. StrategyFoundry's corrections doc gains how it enables the plugin, once this is delivered.
