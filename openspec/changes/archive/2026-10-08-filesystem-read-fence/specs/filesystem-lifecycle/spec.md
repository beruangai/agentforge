## ADDED Requirements

### Requirement: The handler receives each filesystem's directory and baseline permissions
The handler SHALL receive, for each mounted filesystem and merged across all of them, its directory and baseline permission rules: reading the whole mount, and writing its write scope. It SHALL also receive every mounted directory together, to give a run as working directories, so that a run whose reads are fenced to its working directories can read its own mounts and no other. AgentForge SHALL NOT apply either to an agent run; the handler decides.

#### Scenario: Baseline rules follow the scopes
- **WHEN** a filesystem mounted at `/workspace/vault` may write only `notes/today.md`
- **THEN** its baseline allows `Read(//workspace/vault/**)` and `Edit(//workspace/vault/notes/today.md)`, and nothing else

#### Scenario: A fenced run reads its own mounts and no other
- **WHEN** a run fences reads to its working directories and is given its task's mounted directories as working directories
- **THEN** it reads a file in its own mount, and a read of a file in a directory outside them is refused, even where an allow rule names that directory

## REMOVED Requirements

### Requirement: The handler receives each filesystem's path and baseline permissions
**Reason**: The handler also receives the mounted directories to give a run as working directories, and the baseline no longer follows a read scope. Replaced by "The handler receives each filesystem's directory and baseline permissions".
**Migration**: Pass the task's mounted directories to a run as its additional working directories beside the merged allow rules.

## MODIFIED Requirements

### Requirement: Scope is resolved per request and bounds every push
A filesystem SHALL resolve, from the request's input and context, what it mounts and the write scope within it; the write scope SHALL default to the whole mount when the filesystem pushes, and SHALL be empty when it does not. A push SHALL upload and delete only within the write scope.

#### Scenario: A file written outside the write scope stays local
- **WHEN** a filesystem that may write only `notes/today.md` finds another changed file at push
- **THEN** only `notes/today.md` is pushed
