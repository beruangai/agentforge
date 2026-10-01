## Purpose
Gives an agent run Claude Code's auto memory — the `MEMORY.md` index and the topic files it lists — kept in a directory the run declares, so what an agent learns in one task can be recalled in a later one, and kept nowhere when the run declares none.

## ADDED Requirements

### Requirement: A run keeps its auto memory in the directory it declares
An agent run SHALL be able to declare a memory directory, an absolute path. Such a run SHALL have Claude Code's auto memory pointed at that directory: the directory's `MEMORY.md` index SHALL be in the agent's context from its first turn, and the agent SHALL be instructed where its memory is, when to save a memory, the form of a memory file and of its index line. A memory saved by one run SHALL be recalled by a later run that declares the same directory. Memory SHALL be only what Claude Code manages through `MEMORY.md`, never a `CLAUDE.md`. When the directory is a mounted filesystem that persists (see [filesystem-lifecycle](../filesystem-lifecycle/spec.md)), the memory SHALL outlive the container as that filesystem's files do. A declared directory that is not absolute SHALL fail the run with cause `EXECUTION_ERROR` before the agent starts.

#### Scenario: A memory saved in one run is recalled in the next
- **WHEN** a run that declares a memory directory and may write files is told a fact to remember, and a later run that declares the same directory, with no tools, is asked for it
- **THEN** the directory holds a memory file and a `MEMORY.md` line for it after the first run, and the second run answers with the fact

#### Scenario: Memory outlives its container
- **WHEN** a deployed agent's task saves a memory in a directory mounted from a persisted filesystem, its container is stopped, and a later task in another container mounts the same space and is asked for the fact
- **THEN** the later task answers with the fact

#### Scenario: A directory that is not absolute
- **WHEN** a run declares a relative memory directory
- **THEN** the run fails with cause `EXECUTION_ERROR` naming the directory, and the agent never starts

### Requirement: A run that declares no memory keeps none
An agent run that declares no memory directory SHALL have auto memory off: no memory index SHALL be loaded into its context, and the agent SHALL NOT be pointed at any memory directory, including the container's default one, so nothing carries from one task to the next through it.

#### Scenario: No memory declared
- **WHEN** a run declares no memory directory
- **THEN** the agent's session reports no auto-memory directory, and no memory index is in its context

### Requirement: Memory instructions join the procedure's own system prompt
The instructions a declared memory calls for SHALL be added to the run's system prompt after the procedure's own, whatever form the procedure gave it; with no system prompt of the procedure's, they SHALL be the system prompt. The system prompt the run records and logs SHALL be the one the agent received. A run that declares memory under Claude Code's `claude_code` preset SHALL fail with cause `EXECUTION_ERROR` before the agent starts, since the preset carries memory instructions of its own; a run under the preset that declares none SHALL be unaffected.

#### Scenario: The procedure's prompt comes first
- **WHEN** a run with a system prompt of its own declares a memory directory
- **THEN** the agent's system prompt is the procedure's prompt followed by the memory instructions, and the run's record carries the hash of that combined prompt

#### Scenario: Memory under the preset
- **WHEN** a run under the `claude_code` preset declares a memory directory
- **THEN** the run fails with cause `EXECUTION_ERROR` naming the preset, and the agent never starts

### Requirement: Declaring a directory is the one way to configure memory
A run SHALL NOT set Claude Code's auto-memory settings itself — `autoMemoryEnabled` or `autoMemoryDirectory` in its settings, or `CLAUDE_CODE_DISABLE_AUTO_MEMORY` in its environment. One that does SHALL fail with cause `EXECUTION_ERROR` naming the setting, before the agent starts. A run whose settings are a file path SHALL fail the same way when it declares a memory directory, since the directory cannot be added to them.

#### Scenario: A procedure sets the memory directory itself
- **WHEN** a run sets `autoMemoryDirectory` in its own settings
- **THEN** the run fails with cause `EXECUTION_ERROR` naming the setting and pointing to the memory declaration, and the agent never starts
