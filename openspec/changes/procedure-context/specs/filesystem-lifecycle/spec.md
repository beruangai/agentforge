## MODIFIED Requirements

### Requirement: The handler receives each filesystem's directory and baseline permissions
The handler SHALL receive, for each mounted filesystem, its directory and baseline permission rules: reading the whole mount, and writing its write scope. It SHALL also receive, as one set of agent run options it can compose into a run's own, every mounted directory as an additional working directory and every mount's baseline rules as allowed tools — and nothing else — so that a run whose reads are fenced to its working directories can read its own mounts and no other. A procedure with no mounted filesystem SHALL receive an empty set. AgentForge SHALL NOT apply either to an agent run; the handler decides.

#### Scenario: Baseline rules follow the scopes
- **WHEN** a filesystem mounted at `/workspace/vault` may write only `notes/today.md`
- **THEN** its baseline allows `Read(//workspace/vault/**)` and `Edit(//workspace/vault/notes/today.md)`, and nothing else

#### Scenario: One set of run options for every mount
- **WHEN** a procedure registers two filesystems, mounted at `/workspace/vault` and `/workspace/notes`
- **THEN** the run options it receives name both directories as additional working directories and allow both mounts' baseline rules, and set nothing else

#### Scenario: No filesystem, no options
- **WHEN** a procedure registers no filesystem
- **THEN** the run options it receives are empty

#### Scenario: A fenced run reads its own mounts and no other
- **WHEN** a run fences reads to its working directories and composes its task's run options into its own
- **THEN** it reads a file in its own mount, and a read of a file in a directory outside them is refused, even where an allow rule names that directory
