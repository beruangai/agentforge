## ADDED Requirements

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
