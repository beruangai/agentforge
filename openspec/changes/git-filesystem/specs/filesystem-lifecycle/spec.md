# Spec Delta

## ADDED Requirements

### Requirement: A mount's local copy carries to the next task in its runtime session
Unmounting SHALL keep a mount's local copy unless its filesystem declares that the copy is removed, and SHALL release the directory's claim either way. A kept copy lasts as long as its container, which the runtime's lifecycle settings govern. A kept copy SHALL be identified by its local directory, its filesystem's kind, its store and its remote path, and the runtime session of the task that left it.

A later task that mounts the same local directory for the same kind, store and remote path, in the same runtime session, SHALL start from the kept copy, brought up to date by its pull:
- The pull SHALL keep each local change an earlier task left whose file the store has not changed since.
- It SHALL take from the store every file the store changed, and restore a file the store has and the copy does not.
- Where the store and the copy both changed a file, the kind decides which is kept: an S3 filesystem keeps the later of the two, and a git filesystem as [filesystem-git](../filesystem-git/spec.md) states. Each local change a pull discards SHALL be logged, naming the file.
- An S3 filesystem's pull SHALL NOT take a deletion from the store, so a file another writer deleted stays in the copy, and its push may restore it. A procedure that shares a store with writers that delete prevents this by removing its copy or by its subpaths.

Before a mount, every kept copy at its local directory, or around or inside it, that is not identified as above SHALL be removed. That includes one left by another runtime session or for another store. So a copy never carries from one runtime session or store to another. A scratch filesystem's copy SHALL always be removed.

#### Scenario: The next task in the session reuses the copy
- **WHEN** a task's filesystem is unmounted, and a later task in the same runtime session mounts the same filesystem at the same local directory
- **THEN** the later task's mount starts from the kept copy, and its pull fetches only what the store changed since

#### Scenario: A failed task's work carries
- **WHEN** a task that pushes only on `TASK_STATE_COMPLETED` fails after changing `notes/today.md`, and the next task in its runtime session mounts the same directory while the store's `notes/today.md` is unchanged
- **THEN** the next task finds the failed task's `notes/today.md`

#### Scenario: Removal declared
- **WHEN** a filesystem declares its local copy removed, and its task is unmounted
- **THEN** its local directory no longer exists

#### Scenario: Another runtime session mounts the directory
- **WHEN** a task of one runtime session leaves a kept copy, and a task of another runtime session in the same container mounts the same local directory
- **THEN** the second task starts from a fresh pull of the store, with none of the first task's local changes

#### Scenario: Another store at the same directory
- **WHEN** a kept copy was left for one bucket, and a task in the same runtime session mounts a filesystem of another bucket, repository, branch or remote path at the same local directory
- **THEN** the kept copy is removed before the mount, and nothing of it reaches the other store

#### Scenario: A kept copy inside the mount
- **WHEN** a kept copy is at `/workspace/vault/a`, and a task mounts `/workspace/vault`
- **THEN** the copy at `/workspace/vault/a` is removed before the mount, and the mount holds only what its pull brings

#### Scenario: An S3 copy and another writer's delete
- **WHEN** another writer deletes `notes/old.md` from an S3 filesystem's store after a task left a kept copy holding it, and the next task mounts and pushes
- **THEN** the next task still finds `notes/old.md`, and its push may restore it to the store

## MODIFIED Requirements

### Requirement: The handler receives each filesystem's directory and permissions as data
The handler SHALL receive, for each mounted filesystem, its directory and its baseline permissions. The permissions SHALL be stated as actions on globs relative to the mount: `read` on the whole mount, `edit` on each glob of its write scope, and, when the filesystem enables deletes, `delete` on each glob of its write scope. They SHALL name no framework's rule syntax. Turning a procedure's mounts into a run's options is its framework's (see [harness-framework](../harness-framework/spec.md)). AgentForge SHALL NOT apply the permissions to an agent run; the handler decides.

#### Scenario: Baseline permissions follow the scopes
- **WHEN** a filesystem mounted at `/workspace/vault` may write only `notes/today.md`
- **THEN** the handler receives `/workspace/vault` with `read` on the whole mount and `edit` on `notes/today.md`, relative to it, and no other permission

#### Scenario: A filesystem that writes nothing
- **WHEN** a filesystem's scope declares no write globs
- **THEN** its baseline permissions are `read` on the whole mount alone

#### Scenario: A filesystem that deletes
- **WHEN** a filesystem mounted at `/workspace/vault` that may write `notes/**` enables deletes
- **THEN** its baseline permissions are `read` on the whole mount, `edit` on `notes/**` and `delete` on `notes/**`
