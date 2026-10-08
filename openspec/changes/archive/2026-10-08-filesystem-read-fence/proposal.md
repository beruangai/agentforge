# Proposal

## Why

Procedures run in `dontAsk`, and a mount's baseline rules name only its own directory. So today an agent cannot read another task's mount through the file tools or read-only Bash. That holds only as long as the procedure grants nothing broader and stays in `dontAsk`. A broad `Read` rule, or another permission mode, reaches every file in the container, including the mounts of the other tasks it holds at once.

Claude Code's `permissions.blockReadsOutsideWorkingDirectories` closes that in every mode. Spiked 2026-10-02 ([research](../../../docs/research/claude-agent-sdk.md), "Reads outside the working directories"), it refuses reads outside the working directories even where an allow rule grants them, while the auto-memory directory stays readable. It is defence in depth, not isolation: Bash that is not read-only gets around it. It follows `filesystem-local-isolation`, which keeps two tasks from sharing a local directory.

## What Changes

- **Mounts become working directories.** The handler receives every mounted directory beside the merged permissions. It passes them to a run as the SDK's `additionalDirectories`, so each mount is readable without a rule. As with flag-added directories, a mount's `.claude/` skills, commands and subagents load; that is intended.
- **The fence is on by default** in a generated project's base options: `settings.permissions.blockReadsOutsideWorkingDirectories: true`. A procedure may turn it off. The examples' base options gain it by hand, as their scaffolds are already detached.
- **BREAKING: a scope's `read` globs are removed.** Under the fence a directory is readable only as a working directory, and a working directory is readable whole, so a narrower read scope cannot bind. Nothing outside tests declares one. A mount's baseline rules keep `Read` for the whole mount, which still serves a run without the fence. `write` is unchanged and still bounds every push.
- **The examples pass their mounts as working directories** and run fenced, local and on AgentCore.

## Capabilities

### New Capabilities
None.

### Modified Capabilities
- `filesystem-lifecycle`:
  - a scope resolves what a filesystem mounts and what it may write, no longer a read scope;
  - the handler receives each mount's directory, to add as a working directory, beside its baseline rules.
- `plugin-agentic-project`: a generated project's base options fence reads outside the working directories.

## Impact

- **Interface:**
  - `FilesystemScope.read` is removed;
  - `TaskContext` gains `filesystemDirectories: readonly string[]`, every mount's `localPath`.

  The filesystem interface is where a procedure learns its mounts, so it is where it learns their directories.
- **Plugin:** the base-options scaffold. Scaffolds are written once, so an existing project adds the setting by hand.
- **No change** to the kernel, the A2A contract, the task protocol, the runtime or the infrastructure constructs.
- **Requirements:**
  - §REQ403: one task's files are not read by another's agent, by the file tools or read-only Bash, in any mode;
  - §REQ401: the handler still decides what a run is given.
- **Open options:** none depended on.

## Non-goals

- Isolation from Bash that is not read-only, such as an interpreter a procedure allows. That needs a sandbox or a container per task.
- A kernel-enforced fence. The house default sets it, and a procedure may turn it off.
- Fencing writes. `dontAsk` already denies an edit no `Edit` rule allows.
