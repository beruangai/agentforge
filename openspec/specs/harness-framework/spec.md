# harness-framework Specification

## Purpose
Runs a procedure's agent runs through its project's framework, the agent SDK the project chose. The framework turns the mounts into the run's options in its own terms, and names itself on every run's record. The secrets a framework requires are stated where they are required: [plugin-agentic-connection](../plugin-agentic-connection/spec.md) and [infra-agent-runtime](../infra-agent-runtime/spec.md).

## Requirements

### Requirement: A procedure runs under its project's framework
Each agentic project SHALL run its procedures' agent runs through exactly one framework: `claude`, the Claude Agent SDK, unless the project chose another (see [plugin-agentic-project](../plugin-agentic-project/spec.md)). The shared procedure surface SHALL carry no framework's types. A run's options, its prompt's rendering and its framework-specific utilities SHALL come from the framework's own surface, so a procedure written for one framework does not compile against another.

#### Scenario: A new project runs on the Claude Agent SDK
- **WHEN** a consumer generates an agentic project without naming a framework, and an agent's procedure makes a run
- **THEN** the run goes through the Claude Agent SDK, and its record names the `claude` framework

#### Scenario: The shared surface needs no agent SDK
- **WHEN** a module imports only the shared procedure surface, in a workspace with no agent SDK installed
- **THEN** it compiles, and its types name no agent SDK's

### Requirement: The framework derives a run's options from the mounts
Once a procedure's filesystems are mounted (see [filesystem-lifecycle](../filesystem-lifecycle/spec.md)), the handler SHALL receive one set of run options derived by its framework from every mount's directory and permissions, and nothing else. The options SHALL be in the framework's own terms, and a procedure with no mount SHALL receive an empty set. AgentForge SHALL NOT apply them to an agent run; the handler composes them into a run's own. For `claude`, every mount SHALL be an additional working directory and its permissions allow rules, so a run whose reads are fenced to its working directories can read its own mounts and no other.

#### Scenario: Claude's rules follow the scopes
- **WHEN** a `claude` procedure's filesystem mounted at `/workspace/vault` may write only `notes/today.md`
- **THEN** its run options name `/workspace/vault` as an additional working directory, and allow `Read(//workspace/vault/**)` and `Edit(//workspace/vault/notes/today.md)` and nothing else

#### Scenario: One set of run options for every mount
- **WHEN** a procedure registers two filesystems, mounted at `/workspace/vault` and `/workspace/notes`
- **THEN** the run options it receives name both mounts as additional working directories and allow both mounts' rules, and set nothing else

#### Scenario: No filesystem, no options
- **WHEN** a procedure registers no filesystem
- **THEN** the run options it receives are empty

#### Scenario: A fenced run reads its own mounts and no other
- **WHEN** a `claude` run fences reads to its working directories and composes its task's run options into its own
- **THEN** it reads a file in its own mount, and a read of a file in a directory outside them is refused, even where an allow rule names that directory

### Requirement: Every run's record names its framework and keeps its usage whole
Every agent run's record SHALL name its framework twice: by type (`claude`), for matching runs categorically, and by full name, the SDK and its version. It SHALL carry the token usage every framework reports: input, output, cache reads and cache writes. It SHALL also carry the framework's own usage result, as the framework reported it. Cost SHALL be recorded where the framework reports it and be absent where it does not, never estimated. The run the procedure receives SHALL carry the same usage, so the procedure decides what to promote into its output.

#### Scenario: A Claude run's record
- **WHEN** a `claude` run ends
- **THEN** its record names the `claude` framework and the Agent SDK's version, carries its token usage, the SDK's own usage result and its cost, and the procedure's run carries the same usage

#### Scenario: A framework that reports no cost
- **WHEN** a run's framework reports token usage but no cost
- **THEN** its record carries the usage and no cost, and is otherwise complete
