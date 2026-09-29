## MODIFIED Requirements

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
