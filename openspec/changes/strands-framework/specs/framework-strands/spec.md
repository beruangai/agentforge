## Purpose

Runs a `strands` project's agent runs through Strands Agents on the Anthropic API. It holds what such a project relies on beyond the settlement, session, context and observability capabilities every framework meets: its credential and spend bound, the attempts it allows a structured output, its file tool's write scope, where its memory and offloaded results persist, and how its layers' instructions compose.

## ADDED Requirements

### Requirement: A Strands project runs on the Anthropic API with the key it declares
A project generated for the `strands` framework (see [plugin-agentic-project](../plugin-agentic-project/spec.md)) SHALL run its agent runs through Strands Agents on the Anthropic API, authenticated by an API key that the framework requires as its secret, as serving and deploying require every framework's (see [plugin-agentic-agent](../plugin-agentic-agent/spec.md)). No other credential for a model provider SHALL be present in its containers. A run refused because the provider account's spend limit is reached SHALL fail with cause `BUDGET_EXHAUSTED`, not retryable, saying that the limit must be raised. A rejected key SHALL fail the run with cause `CREDENTIAL_EXPIRED`.

#### Scenario: A Strands run's record
- **WHEN** an agent of a `strands` project makes a run
- **THEN** the run goes through the Anthropic API, and its record names the `strands` framework and its SDK's version, carries its token usage and Strands' own usage, and no cost

#### Scenario: The spend limit reached
- **WHEN** a run is refused because the provider account's spend limit is reached
- **THEN** it fails with cause `BUDGET_EXHAUSTED`, not retryable, and the suggested action says to raise the limit

### Requirement: A Strands run's structured output is bounded and settles once
A `strands` run SHALL meet every rule of an agent run's settlement (see [harness-kernel-settlement](../harness-kernel-settlement/spec.md)). The agent's structured-output attempts SHALL be bounded by AgentForge, five unless the run sets another bound, since Strands bounds none. No work SHALL run in the background: subagents and tools complete before the answer counts. Every MCP server a run is given SHALL start, or the run SHALL fail with cause `EXECUTION_ERROR` naming it before the agent's first turn; a cancel SHALL stop the wait for one to start, and each SHALL be stopped once the run is over, however it ended.

#### Scenario: Attempts exhausted
- **WHEN** a `strands` run's agent submits a structured output its contract refuses five times
- **THEN** the run fails with cause `OUTPUT_INVALID`, carrying the last refusal

#### Scenario: An MCP server that does not start
- **WHEN** a `strands` run is given an MCP server that fails to start
- **THEN** the run fails with cause `EXECUTION_ERROR` naming the server, and the agent never starts

### Requirement: A Strands run's file tool edits only within its mounts' write scopes
The run options the `strands` framework derives from a procedure's mounts (see [harness-framework](../harness-framework/spec.md)) SHALL name every mount to the agent as a directory it works in. They SHALL refuse an edit through the file tool of a path outside the write globs of every mount, while the run composes them into its own. They SHALL NOT bound what a shell command writes: which commands a run may execute is its procedure's own allow list, as it is for `claude`'s shell. AgentForge SHALL NOT apply them unless the handler composes them.

#### Scenario: An edit inside the write scope
- **WHEN** a `strands` run whose mount at `/workspace/vault` may write `notes/*.md` composes its task's run options, and its agent writes `notes/today.md`
- **THEN** the file is written

#### Scenario: An edit outside the write scope
- **WHEN** the same run's agent edits `/workspace/vault/index.md` with the file tool
- **THEN** the edit is refused, and the agent is told why

### Requirement: A Strands agent's memory and offloaded results persist with its sessions
A `strands` agent SHALL keep its memory and the tool results it offloads in the same storage as its sessions, which persist and resume as every agent's do (see [harness-session-persistence](../harness-session-persistence/spec.md)): deployed in the project's session bucket under the agent's name, served locally in the local store. A run that declares a memory space SHALL keep its memory there, recalled by a later run that declares the same space, and one that declares none SHALL keep none. A write, read or listing the storage fails SHALL fail the run with cause `EXECUTION_ERROR`, as an incomplete session does, rather than leave the run without the memory or result it asked for.

#### Scenario: A memory recalled in a later task
- **WHEN** a `strands` run that declares a memory space is told a fact to remember, its container is stopped, and a later run in another container declares the same space and is asked for it
- **THEN** the later run answers with the fact

#### Scenario: No memory declared
- **WHEN** a `strands` run declares no memory space
- **THEN** nothing from an earlier task's memory is in its context

#### Scenario: The storage refuses a write
- **WHEN** the storage does not accept a write a run makes to its memory or an offloaded result
- **THEN** the run fails with cause `EXECUTION_ERROR`

#### Scenario: The storage fails a read
- **WHEN** the storage fails a read or listing a run makes to recall its memory
- **THEN** the run fails with cause `EXECUTION_ERROR`, rather than going on without the memory

### Requirement: A Strands agent's layers compose their instructions
A `strands` agent's instructions and skills SHALL compose from its project's base layer, then its own layer, under Strands' own directory and file names. A layer's instructions SHALL join the procedure's system prompt, and AgentForge's own system-prompt fragments SHALL follow the procedure's prompt.

#### Scenario: Base and agent instructions
- **WHEN** a `strands` project's base layer and an agent each carry instructions and a skill, and the agent makes a run
- **THEN** the agent's context holds the base layer's instructions, then its own, and both skills are available

#### Scenario: An instruction file that cannot be read
- **WHEN** a layer's instruction file exists but cannot be read
- **THEN** the run fails with cause `EXECUTION_ERROR` naming the file, before the agent starts
