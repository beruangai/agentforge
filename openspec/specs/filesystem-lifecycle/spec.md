# filesystem-lifecycle Specification

## Purpose

Gives procedures file I/O that AgentForge manages: filesystems a procedure registers, mounted before its handler, synced as declared, and unmounted once its outcome is known — persistent or ephemeral, of any kind.

## Requirements

### Requirement: Filesystems are registered by middleware, appending by default
A procedure's filesystems SHALL be registered by middleware, by name. Registering a name already registered upstream SHALL replace that entry; other entries SHALL be kept. A registration that declares it replaces upstream SHALL drop everything registered upstream.

#### Scenario: A procedure adds to its house's filesystems
- **WHEN** an agentic project registers `workspace` and `scratch`, and a procedure registers `workspace` again and `notes`
- **THEN** the procedure mounts `scratch`, `notes`, and the procedure's `workspace`

#### Scenario: A procedure drops its house's filesystems
- **WHEN** a procedure registers `notes`, replacing upstream
- **THEN** the procedure mounts only `notes`

### Requirement: Filesystems mount before the handler and unmount after the outcome
Every registered filesystem SHALL be mounted, pulling its scope from its store, before the procedure's handler runs, and SHALL be unmounted once the task's outcome is known. Unmounting SHALL push only when the filesystem's `pushOn` lists the task's terminal state (`TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`), never on cancellation or when the task is stopped at its time budget, where only its checkpoints persist — and the outcome SHALL be published only after those pushes are verified. A task SHALL never report `TASK_STATE_COMPLETED` over a push that was not verified.

#### Scenario: The handler reads a pulled filesystem before any agent runs
- **WHEN** a procedure registers a filesystem
- **THEN** its files are present at its path when the handler starts

#### Scenario: A push that fails fails a completed task
- **WHEN** a completed task's push fails or cannot be verified
- **THEN** the task ends `TASK_STATE_FAILED` with cause `FILESYSTEM_UNSYNCED`, retryable

#### Scenario: A push that fails keeps a failed task's cause
- **WHEN** a failed task's push, on `TASK_STATE_FAILED`, fails
- **THEN** the task keeps its own cause, and the push's failure is added to the cause's message

#### Scenario: A mount that fails fails the task
- **WHEN** a filesystem cannot be mounted or pulled
- **THEN** the handler does not run, and the task ends `TASK_STATE_FAILED` with cause `FILESYSTEM_UNSYNCED`

#### Scenario: A timed-out task pushes nothing
- **WHEN** a task whose filesystem pushes on `TASK_STATE_FAILED` runs past its time budget
- **THEN** the task ends `TIMED_OUT`, and nothing is pushed beyond its checkpoints

### Requirement: Scope is resolved per request and bounds every push
A filesystem SHALL resolve, from the request's input and context, the subtree it mounts and the read and write scopes within it; the read scope defaults to the whole mount, and the write scope does too when the filesystem pushes and is empty when it does not. A push SHALL upload and delete only within the write scope.

#### Scenario: A file written outside the write scope stays local
- **WHEN** a filesystem that may write only `notes/today.md` finds another changed file at push
- **THEN** only `notes/today.md` is pushed

### Requirement: The handler receives each filesystem's path and baseline permissions
The handler SHALL receive, for each mounted filesystem and merged across all of them, its path and baseline permission rules for its read and write scopes. AgentForge SHALL NOT apply them to an agent run; the handler decides.

#### Scenario: Baseline rules follow the scopes
- **WHEN** a filesystem mounted at `/workspace/vault` may read everything and write only `notes/today.md`
- **THEN** its baseline allows `Read(//workspace/vault/**)` and `Edit(//workspace/vault/notes/today.md)`, and nothing else

### Requirement: A kind decides where it mounts, and what it needs
Each filesystem kind SHALL either set a default path the consumer may override, or require the consumer to give one, and SHALL refuse options it cannot honour before anything is mounted. Two filesystems of one procedure SHALL NOT share a local path or nest one inside the other; the task SHALL fail before anything is mounted.

#### Scenario: A scratch filesystem needs no declaration
- **WHEN** a procedure registers a scratch filesystem with no options
- **THEN** it mounts an empty directory of the task's own, removed when the task ends

#### Scenario: An S3 filesystem refuses an unsafe delete
- **WHEN** an S3 filesystem enables deletes on its whole bucket
- **THEN** the task fails `EXECUTION_ERROR` before anything is mounted

#### Scenario: Two filesystems at one directory
- **WHEN** a procedure registers two filesystems whose local paths are the same, or one inside the other
- **THEN** the task fails `EXECUTION_ERROR`, naming both, before anything is mounted

### Requirement: The handler resolves paths inside a mount
For each mounted filesystem, the handler SHALL be able to resolve a path relative to its mount into its local path. Resolving SHALL refuse a path that is absolute or climbs out of the mount. Resolving a path for writing SHALL also refuse one outside the filesystem's write scope, so a write the push would leave behind is refused when it is resolved, not lost after the run.

#### Scenario: A path inside the mount
- **WHEN** a handler resolves `notes/today.md` on a filesystem mounted at `/workspace/vault`
- **THEN** it receives `/workspace/vault/notes/today.md`

#### Scenario: A path that climbs out
- **WHEN** a handler resolves `../other/secret.md`, or an absolute path, on a mounted filesystem
- **THEN** resolving throws, naming the path and the mount

#### Scenario: A write outside the write scope
- **WHEN** a handler resolves `index.md` for writing on a filesystem whose write scope is only `notes/**`
- **THEN** resolving throws, naming the path and the write scope
