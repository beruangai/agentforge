# Proposal

## Why

An agent that learns something worth keeping in one task — a correction, a preference, a decision and why it was made — has no place to keep it for the next: the container ends and nothing carries (§REQ403). Claude Code's auto memory is that place, but in an SDK run it is in the container's home directory and the model saves nothing without memory instructions. Getting those instructions from Claude Code means the `claude_code` preset, which AgentForge does not use. Both consumers want an agent's memory to persist across tasks, so AgentForge gives a run auto memory, kept where a filesystem the procedure declares makes it durable.

## What Changes

- **A run may declare a memory directory** (new §REQ404). The run keeps Claude Code's auto memory there: the `MEMORY.md` index and its topic files, and only those — never a `CLAUDE.md`. It is optional; a run that declares none has auto memory off, so nothing carries through the container's default memory directory either (§REQ403).
- **The run is pointed at the directory through the SDK's own settings** (`autoMemoryDirectory`), verified 2026-10-01 ([research](../../../docs/research/claude-agent-sdk.md), "Auto memory in an SDK run").
- **Memory instructions without the preset.** AgentForge adds a memory instruction fragment to the run's system prompt. It tells the agent where its memory is, when to save, the file format and the index rule, and was verified to make the agent save memories. The `claude_code` preset is never used for this, and a run that declares memory under the preset is refused.
- **Fragments are chosen from what a run declares.** The memory fragment is the first entry of a small registry of system-prompt fragments. The kernel appends each fragment the run's declaration calls for after the procedure's own system prompt.
- **Durability is a filesystem's.** A memory directory is a mounted filesystem's directory (see `filesystem-lifecycle`). Persisted, it is an `S3Filesystem` over one memories bucket the deployment declares. Each memory space is a folder in that bucket, chosen by the consumer through the filesystem's scope. No new filesystem kind and no new infrastructure construct.
- **The kernel owns the memory settings.** A procedure that sets `autoMemoryEnabled` or `autoMemoryDirectory` in its own `settings`, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY` in its `env`, is refused: declaring a memory directory is the one way to get memory.
- **Examples:** `smoke-coverage` gains a procedure pair that saves a memory in one task and recalls it in a later task in another container, on AgentCore.

## Capabilities

### New Capabilities
- `harness-auto-memory`: a run's auto memory: kept in the directory it declares, saved through instructions AgentForge adds to its system prompt, off when it declares none.

### Modified Capabilities
None. `filesystem-lifecycle` already makes a mounted directory durable and is used as it is.

## Impact

- **Interface:** `AgentRunSpec` gains `memoryDirectory`, the directory a run keeps its auto memory in. This is the harness's run interface, where everything else a run declares lives. `/agent` exports nothing new beyond it.
- **Kernel:** it composes the system prompt from the procedure's own prompt and the fragments the run calls for, and sets the auto-memory settings or the variable that disables them. The prompt it logs and records is the composed one.
- **No change** to the A2A contract, the task protocol, the runtime, the filesystems or the infrastructure constructs.
- **Requirements:** serves §REQ404 (new) and keeps §REQ403. §REQ401 is untouched: the memory space is the consumer's identifier, carried in its filesystem's scope.
- **Open options:**
  - **§ODO009 (a local S3-compatible server):** this change leaves it open. Persistence across containers is therefore verified on AgentCore only, as the notebook filesystem is.
  - **§ODO008 (the Claude config directory beyond the transcript):** untouched. The memory directory is outside the config directory, so a resume that swaps the config directory does not move it.

## Non-goals

- `CLAUDE.md` or any memory Claude Code does not manage through `MEMORY.md`.
- Merging concurrent writers. Two tasks writing one memory space at once can overwrite each other's index. Isolation is the consumer's, for example one continuity key per space.
- Auto-dream (background memory consolidation): background work is off (§ODO006).
- A memory-specific filesystem kind, bucket construct or helper.
- Granting the agent tools. A run that should save memories gives itself `Write` and `Edit`; a recall-only run needs none.
