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

### Requirement: A mount is its subpath under the filesystem's local and remote roots
A filesystem SHALL declare a local root, an absolute directory, and MAY declare a remote root, an absolute path within its store; without one, the remote root SHALL be the store's own root, `/`. Its scope SHALL resolve, per request, a subpath relative to both roots, empty for the whole root. The filesystem SHALL mount the store's subtree at the remote root joined with the subpath into the local directory at the local root joined with the same subpath, and only that subtree SHALL be pulled and pushed. A local or remote root that is not absolute, or that climbs, SHALL be refused when the filesystem is declared. A subpath that is absolute or climbs SHALL fail the task with cause `EXECUTION_ERROR` before anything is mounted.

#### Scenario: Two requests, two subpaths
- **WHEN** a filesystem with local root `/workspace/memories` and remote root `/projects/alpha` resolves subpath `spaces/a` for one request and `spaces/b` for another
- **THEN** the first mounts the store's `/projects/alpha/spaces/a` at `/workspace/memories/spaces/a`, and the second the store's `/projects/alpha/spaces/b` at `/workspace/memories/spaces/b`

#### Scenario: The handler sees the resolved mount
- **WHEN** a handler reads a filesystem's path whose local root is `/workspace/memories` and whose subpath resolved to `spaces/a`
- **THEN** the path is `/workspace/memories/spaces/a`, and its baseline permissions are rooted there

#### Scenario: A subpath that climbs
- **WHEN** a scope resolves the subpath `../other` or `/etc`
- **THEN** the task fails with cause `EXECUTION_ERROR` naming the subpath, before anything is mounted

### Requirement: A local mount belongs to one live task
While a task holds a mounted local directory, no other task in the same container SHALL mount that directory, or a directory inside it or containing it. Such a mount SHALL fail before the handler runs, with cause `FILESYSTEM_UNSYNCED`, retryable, naming the directory and the task holding it, and SHALL leave the holding task's files untouched. A task SHALL release its local directories when it unmounts them, and a directory whose holding task's process has ended SHALL be free.

#### Scenario: Concurrent tasks on different subpaths
- **WHEN** two live tasks in one container mount one filesystem whose scopes resolve different subpaths
- **THEN** both mount, each in its own local directory, and each pushes only its own files to its own subtree

#### Scenario: Concurrent tasks on the same subpath
- **WHEN** a task mounts a local directory another live task in the same container holds
- **THEN** it fails with cause `FILESYSTEM_UNSYNCED`, retryable, naming the directory and the other task, its handler never runs, and the other task's files are unchanged

#### Scenario: The directory is free once its task ends
- **WHEN** the task holding a local directory ends, by unmounting or because its process is gone, and another task then mounts the same directory
- **THEN** the mount succeeds

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

### Requirement: A kind decides its local root, and what it needs
Each filesystem kind SHALL either set a default local root the consumer may override, or require the consumer to give one, and SHALL refuse options it cannot honour before anything is mounted. A scratch filesystem's subpath SHALL be its task's own, so a local root it is given holds one directory per task. Two filesystems of one procedure SHALL NOT resolve the same local directory or one inside the other; the task SHALL fail before anything is mounted.

#### Scenario: A scratch filesystem needs no declaration
- **WHEN** a procedure registers a scratch filesystem with no options
- **THEN** it mounts an empty directory of the task's own, removed when the task ends

#### Scenario: A scratch filesystem under a named root
- **WHEN** two live tasks register a scratch filesystem with the same local root
- **THEN** each mounts its own empty directory under that root

#### Scenario: An S3 filesystem refuses an unsafe delete
- **WHEN** an S3 filesystem enables deletes while its remote root joined with its subpath is `/`, the whole bucket
- **THEN** the task fails `EXECUTION_ERROR` before anything is mounted

#### Scenario: Two filesystems at one directory
- **WHEN** a procedure registers two filesystems whose resolved local directories are the same, or one inside the other
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
