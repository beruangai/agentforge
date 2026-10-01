## ADDED Requirements

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

## REMOVED Requirements

### Requirement: A kind decides where it mounts, and what it needs
**Reason**: A kind now decides a local root, not a path: where it mounts is the root joined with the subpath its scope resolves, and the overlap check runs on that resolved directory. Replaced by "A kind decides its local root, and what it needs".
**Migration**: An `S3Filesystem`'s `localPath` option is its `localRoot`, and its scope returns `subpath` where it returned `remotePath`; a scratch filesystem's named path is its `localRoot`, which now holds a directory per task.
