# How the Agent SDK composes capabilities — measured

**Measured 2026-09-22** against `@anthropic-ai/claude-agent-sdk@0.3.278`, then corrected the same day against the authoritative pages ([settings sources](https://code.claude.com/docs/en/agent-sdk/claude-code-features#control-filesystem-settings-with-settingsources), [additional directories](https://code.claude.com/docs/en/permissions#additional-directories-grant-file-access-not-configuration)). Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §L / §REQ203. Source: `spikes/capability-composition/`.

> **Correction.** The first version of this note measured slash commands only and generalised the result to all configuration. That was wrong: the three kinds follow three different rules, and the one that does *not* compose is the one that matters most. It also reported the repository boundary as an undocumented trap; it is documented behaviour, scoped to skills, commands and subagents.

## Three kinds, three rules

| Kind | Loads from |
|---|---|
| `settings.json` and **hooks** | **`<cwd>/.claude/` only — no parent fallback** |
| `CLAUDE.md` and `.claude/rules/*.md` | `<cwd>` and **every** parent |
| **skills, commands, subagents** | `<cwd>` and every parent **up to the repository root** |

Measured with one marker of each kind at four levels — a user directory, an agentic-project directory, an agent directory, and `cwd` — using the `system` init message for skills, commands and subagents, and a `SessionStart` hook that writes a file for `settings.json`:

| | user | agentic project | agent | procedure (`cwd`) |
|---|---|---|---|---|
| commands | ✓ | ✓ | ✓ | ✓ |
| skills | ✓ | ✓ | ✓ | ✓ |
| subagents | ✓ | ✓ | ✓ | ✓ |
| **hooks / `settings.json`** | ✓ | **·** | **·** | ✓ |

With a `.git` planted at the agent level, the agentic-project layer drops out of skills, commands and subagents — and nothing else changes:

| with `.git` at the agent level | user | agentic project | agent | procedure |
|---|---|---|---|---|
| commands / skills / subagents | ✓ | **·** | ✓ | ✓ |
| hooks / `settings.json` | ✓ | · | · | ✓ |

`skills: 'all'` made no difference; discovered skills are listed without it.

`CLAUDE.md` and rules were **not** measured here. The documented rule — every parent, with no repository limit — is taken as read rather than confirmed.

## What this means for the layered design

**Capabilities layer natively; settings do not.**

- **Skills, commands, subagents, `CLAUDE.md` and rules compose up the tree**, so the intended scheme works: the base image contributes at the user scope, the agentic project's image at its level, each agent's image at its own, a procedure below that. A nearer layer overrides a further one by name. No build-time composition step.
- **`settings.json` and hooks do not.** An image layer **cannot grant itself permissions or install a hook from its own directory level** — only `<cwd>/.claude/` and the user scope are read. This is the constraint the first version of this note missed, and it decides where permissions come from.

**So per-layer and per-procedure settings come from the SDK, not the filesystem.** The `settings` option takes an inline object, a file path or a JSON string and populates the flag-settings layer in the precedence order,; a run is one query, so it is passed once and nothing needs to change it mid-session. That is the mechanism for scoping Read/Write permissions to the context a procedure was asked for — entity, user, strategy — and it is what the predecessor harness already does. **AgentForge composes the settings itself and passes them inline.**

**The repository boundary is a layout rule, not a bug.** Skills, commands and subagents stop at a repository root, so every capability layer must sit *below* any `.git` in the chain, or repositories must stay out of it. It is silent either way — a layer simply does not appear — which is worth a startup assertion that the expected layers actually loaded.

## `additionalDirectories` — two different things with the same name

The earlier note said "`additionalDirectories` contributes capabilities". True of the SDK option, and the distinction matters because the mitigation lives in it:

| | Grants file access | Loads configuration |
|---|---|---|
| The SDK's **`additionalDirectories`** option (passed to Claude Code as `--add-dir`) | yes | **yes** — skills (with live reload), commands, subagents; `enabledPlugins` and `extraKnownMarketplaces` only from `settings.json`; `CLAUDE.md` only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` |
| **`permissions.additionalDirectories`** in a settings file | yes | **no** |

Skills, commands and subagents from a flag-added directory load through the **`project`** setting source, so excluding that source excludes them too.

**In practice this does not arise: a working directory carries no nested `.claude/`.** That is a standing assumption rather than something to enforce — a use case wanting otherwise would be deliberate, and none exists. What *is* load-bearing is that an additional directory's **read and write permissions are declared explicitly in `settings`**, never implied.

## `cwd` is the capability root, not the data directory

`cwd` selects which layers apply and therefore *what the agent is*; the directories a run reads and writes are data, reached through additional directories and permissions. They need not be the same path.

**`ARCHITECTURE.md`'s project-key derivation (§REQ402) says "the working directory the run uses" without saying which**, and the answer changes what transcript continuity is scoped to. Raised in `DESIGN_OPTIONS.md` §L rather than resolved here.
