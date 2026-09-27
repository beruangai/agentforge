# Spec Delta

## Purpose

Gives procedures file I/O that AgentForge manages: filesystems a procedure registers, mounted before its handler, synced as declared, and unmounted once its outcome is known — persistent or ephemeral, of any kind.

## ADDED Requirements

### Requirement: Filesystems are registered by middleware, appending by default
A procedure's filesystems SHALL be registered by middleware, by name. Registering a name already registered upstream SHALL replace that entry; other entries SHALL be kept. A registration that declares it does not inherit SHALL drop everything registered upstream.

#### Scenario: A procedure adds to its house's filesystems
- **WHEN** an agentic project registers `workspace` and `scratch`, and a procedure registers `workspace` again and `notes`
- **THEN** the procedure mounts `scratch`, `notes`, and the procedure's `workspace`

#### Scenario: A procedure drops its house's filesystems
- **WHEN** a procedure registers `notes` without inheriting
- **THEN** the procedure mounts only `notes`

### Requirement: Filesystems mount before the handler and unmount after the outcome
Every registered filesystem SHALL be mounted, pulling its scope from its store, before the procedure's handler runs, and SHALL be unmounted once the task's outcome is known. Unmounting SHALL push as the filesystem declares — `WHEN_COMPLETED` on completion, `WHEN_ENDED` on completion or failure, never on cancellation — and the outcome SHALL be published only after those pushes are verified. A task SHALL never report `TASK_STATE_COMPLETED` over a push that was not verified.

#### Scenario: The handler reads a pulled filesystem before any agent runs
- **WHEN** a procedure registers a filesystem
- **THEN** its files are present at its path when the handler starts

#### Scenario: A push that fails fails a completed task
- **WHEN** a completed task's push fails or cannot be verified
- **THEN** the task ends `TASK_STATE_FAILED` with cause `FILESYSTEM_UNSYNCED`, retryable

#### Scenario: A push that fails keeps a failed task's cause
- **WHEN** a failed task's `WHEN_ENDED` push fails
- **THEN** the task keeps its own cause, and the push's failure is added to the cause's message

#### Scenario: A mount that fails fails the task
- **WHEN** a filesystem cannot be mounted or pulled
- **THEN** the handler does not run, and the task ends `TASK_STATE_FAILED` with cause `FILESYSTEM_UNSYNCED`

### Requirement: Scope is resolved per request and bounds every push
A filesystem SHALL resolve, from the request's input and context, the subtree it mounts and the read and write scopes within it; both default to the whole mount, and a read-only filesystem has no write scope. A push SHALL upload and delete only within the write scope.

#### Scenario: A file written outside the write scope stays local
- **WHEN** a filesystem that may write only `notes/today.md` finds another changed file at push
- **THEN** only `notes/today.md` is pushed

### Requirement: The handler receives each filesystem's path and baseline permissions
The handler SHALL receive, for each mounted filesystem and merged across all of them, its path and baseline permission rules for its read and write scopes. AgentForge SHALL NOT apply them to an agent run; the handler decides.

#### Scenario: Baseline rules follow the scopes
- **WHEN** a filesystem mounted at `/workspace/vault` may read everything and write only `notes/today.md`
- **THEN** its baseline allows `Read(//workspace/vault/**)` and `Edit(//workspace/vault/notes/today.md)`, and nothing else

### Requirement: A kind decides where it mounts, and what it needs
Each filesystem kind SHALL either set a default path the consumer may override, or require the consumer to give one, and SHALL refuse options it cannot honour before anything is mounted.

#### Scenario: A scratch filesystem needs no declaration
- **WHEN** a procedure registers a scratch filesystem with no options
- **THEN** it mounts an empty directory of the task's own, removed when the task ends

#### Scenario: An S3 filesystem refuses an unsafe delete
- **WHEN** an S3 filesystem declares deletes on its whole bucket
- **THEN** the task fails `EXECUTION_ERROR` before anything is mounted
