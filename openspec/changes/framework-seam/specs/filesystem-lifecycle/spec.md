## REMOVED Requirements

### Requirement: The handler receives each filesystem's directory and baseline permissions
**Reason**: The baseline permissions were Claude Code rule strings, and the run options built from them were the Claude Agent SDK's. Both are a framework's concern, not a filesystem's.

**Migration**: A mount's permissions are given as data by "The handler receives each filesystem's directory and permissions as data", below. The run options derived from the mounts, including the fenced-read guarantee, move to [harness-framework](../harness-framework/spec.md)'s "The framework derives a run's options from the mounts". A handler that read `permissions.allow` composes `context.agentOptions` instead.

## ADDED Requirements

### Requirement: The handler receives each filesystem's directory and permissions as data
The handler SHALL receive, for each mounted filesystem, its directory and its baseline permissions. The permissions SHALL be stated as actions on globs relative to the mount: `read` on the whole mount, and `edit` on each glob of its write scope. They SHALL name no framework's rule syntax. Turning a procedure's mounts into a run's options is its framework's (see [harness-framework](../harness-framework/spec.md)). AgentForge SHALL NOT apply the permissions to an agent run; the handler decides.

#### Scenario: Baseline permissions follow the scopes
- **WHEN** a filesystem mounted at `/workspace/vault` may write only `notes/today.md`
- **THEN** the handler receives `/workspace/vault` with `read` on the whole mount and `edit` on `notes/today.md`, relative to it, and no other permission

#### Scenario: A filesystem that writes nothing
- **WHEN** a filesystem's scope declares no write globs
- **THEN** its baseline permissions are `read` on the whole mount alone

## MODIFIED Requirements

### Requirement: A mount is its subpath under the filesystem's local and remote roots
A filesystem SHALL declare a local root, an absolute directory, and MAY declare a remote root, an absolute path within its store; without one, the remote root SHALL be the store's own root, `/`. Its scope SHALL resolve, per request, a subpath relative to both roots, empty for the whole root. The filesystem SHALL mount the store's subtree at the remote root joined with the subpath into the local directory at the local root joined with the same subpath, and only that subtree SHALL be pulled and pushed. A local or remote root that is not absolute, or that climbs, SHALL be refused when the filesystem is declared. A subpath that is absolute or climbs SHALL fail the task with cause `EXECUTION_ERROR` before anything is mounted.

#### Scenario: Two requests, two subpaths
- **WHEN** a filesystem with local root `/workspace/memories` and remote root `/projects/alpha` resolves subpath `spaces/a` for one request and `spaces/b` for another
- **THEN** the first mounts the store's `/projects/alpha/spaces/a` at `/workspace/memories/spaces/a`, and the second the store's `/projects/alpha/spaces/b` at `/workspace/memories/spaces/b`

#### Scenario: The handler sees the resolved mount
- **WHEN** a handler reads a filesystem's path whose local root is `/workspace/memories` and whose subpath resolved to `spaces/a`
- **THEN** the path is `/workspace/memories/spaces/a`, and its baseline permissions are relative to it

#### Scenario: A subpath that climbs
- **WHEN** a scope resolves the subpath `../other` or `/etc`
- **THEN** the task fails with cause `EXECUTION_ERROR` naming the subpath, before anything is mounted
