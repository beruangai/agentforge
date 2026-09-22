# How the Agent SDK composes capabilities — measured

**Measured 2026-09-22** against `@anthropic-ai/claude-agent-sdk@0.3.278`. Answers [`../DESIGN_OPTIONS.md`](../DESIGN_OPTIONS.md) §L / D7. Source: `spikes/capability-composition/l1-nested-scopes.ts`.

Measured rather than read, because **the documentation contradicts itself** on the load-bearing point:

- the [TypeScript SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript) says project settings are "discovered upward from `cwd`. Claude Code traverses up the directory tree."
- the [`.claude` directory reference](https://code.claude.com/docs/en/claude-directory) says "Claude Code does **NOT** walk up parent directories. Discovery is strictly scoped."

The probe needs no model reasoning: each directory level contributes a uniquely named slash command, and the SDK's `system` init message lists the commands it actually loaded.

## Nested `.claude` directories do compose

A tree with one `.claude/` per intended image layer, `cwd` at the deepest:

```
<root>/home/.claude                                      user   (CLAUDE_CONFIG_DIR)
<root>/agentic/.claude                                   agentic project
<root>/agentic/agent/.claude                             agent
<root>/agentic/agent/procedures/discovery/.claude        procedure   <- cwd
```

| `settingSources` | user | agentic project | agent | procedure |
|---|---|---|---|---|
| `['user','project']` | ✓ | ✓ | ✓ | ✓ |
| `['project']` | · | ✓ | ✓ | ✓ |
| omitted (default) | ✓ | ✓ | ✓ | ✓ |

**Discovery walks up from `cwd`.** The SDK reference is correct and the `.claude` directory page is wrong. Every layer above `cwd` contributes, so the layered scheme — base image, agentic project, agent, optionally procedure, each owning one `.claude/` at its own level — works natively, with no composition step at build time.

`['project']` excludes the user layer while keeping **all** nested levels, so the image's own `~/.claude` contribution can be turned off independently of the project chain.

## Two hazards, both silent

### A `.git` directory halts the walk

With a repository at the agent level, the agentic-project layer above it **disappears**:

| | user | agentic project | agent | procedure |
|---|---|---|---|---|
| `.git` at the agent level | ✓ | **·** | ✓ | ✓ |

Nothing errors. The agent simply runs without the layer's skills, commands and instructions.

**This is a live risk, not a theoretical one:** an agent working against a git-based working copy is exactly the predecessor harness's shape. Any repository between `cwd` and a contributing layer takes that layer out silently. The layout must keep every capability layer **below** any repository root, or keep repositories out of the capability chain entirely.

### `additionalDirectories` contributes capabilities, not just read access

A directory passed as `additionalDirectories` **injects its `.claude/` commands into the agent**:

```
additionalDirectories: [<mounted>]   ->   marker-mounted LOADED
```

The SDK reference does say this — with the `project` source enabled it loads "the directory's skills, commands, and subagents" — but it is easy to read `additionalDirectories` as read access with a permission attached, and it is not.

**The consequence is a trust boundary.** A synced or mounted working directory is *data*, and data that can carry a `.claude/` directory can add skills, slash commands and subagents to the agent that reads it. Anything AgentForge syncs down before a run, or mounts from a consumer's store, must either be excluded from capability loading or be treated as trusted input.

## `cwd` is the capability root, not the data directory

The distinction these results force, and which AgentForge's documents have blurred:

| | |
|---|---|
| **`cwd`** | the bottom of the capability chain. It selects which `.claude/` layers apply, and therefore *what the agent is*. |
| **the directories a run reads and writes** | data. Reached through `additionalDirectories` plus permissions, and — per above — able to contribute capabilities unless prevented. |

They are not the same thing and need not be the same path. A procedure that "sets its own working directory" is doing one of two very different things depending on which is meant: changing the agent's capability set, or changing where files land.

**`ARCHITECTURE.md`'s project-key derivation (D17) says "the working directory the run uses" without saying which**, and the answer changes what continuity is scoped to. Raised in `DESIGN_OPTIONS.md` §L rather than resolved here.
