# Spec Delta

## MODIFIED Requirements

### Requirement: The framework derives a run's options from the mounts
Once a procedure's filesystems are mounted (see [filesystem-lifecycle](../filesystem-lifecycle/spec.md)), the handler SHALL receive one set of run options derived by its framework from every mount's directory, its permissions, and the push it offers the agent, if any, and nothing else. The options SHALL be in the framework's own terms, and a procedure with no mount SHALL receive an empty set. AgentForge SHALL NOT apply them to an agent run; the handler composes them into a run's own. For `claude`, every mount SHALL be an additional working directory and its `read` and `edit` permissions allow rules, so a run whose reads are fenced to its working directories can read its own mounts and no other. A `delete` permission SHALL render nothing in any framework: deleting a file is the procedure's own shell allow list. Each mount that offers a push SHALL give the run one tool, allowed, that pushes that mount with the agent's message and returns what it recorded or why it failed (see [filesystem-git](../filesystem-git/spec.md)).

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

#### Scenario: A delete permission renders nothing
- **WHEN** a procedure's filesystem enables deletes
- **THEN** its run options are those of the same filesystem without deletes

#### Scenario: A mount the agent may push
- **WHEN** a procedure's git filesystem `vault` offers a push, and the run composes its task's run options
- **THEN** the agent has one allowed tool that pushes `vault` with a message it gives, in `claude` and in `strands` alike
