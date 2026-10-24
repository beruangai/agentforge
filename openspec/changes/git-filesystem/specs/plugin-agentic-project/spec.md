# Spec Delta

## ADDED Requirements

### Requirement: Seeding a host repository from its remote
An agentic project SHALL have a target that seeds the host repository of a declared repository from its remote: given the repository's name, an `https://` remote, optionally a host location, and optionally a reading clone, it SHALL create a bare repository at the location holding the remote's history and branches, able to serve a partial clone, and declare it for local serving. A location relative to the workspace SHALL be declared in the workspace's committed serving environment, and an absolute one in its uncommitted local one. Without a location, the target SHALL use one inside the workspace and kept out of version control. The target SHALL never write to the remote. It SHALL use the host's own git credentials, refuse a remote with credentials in it before creating anything, and write no credential anywhere. What it creates and declares SHALL be the workspace's, so that running it from any project reaches the same host repository and every project's local serving sees the same declaration. It SHALL never delete or overwrite: running it again SHALL change nothing, and a location or declaration it would have to replace SHALL fail, naming it. Given a reading clone, the target SHALL clone it from the host repository when it is absent, and otherwise point it at the host repository once their histories are shown to share a commit.

#### Scenario: A fresh workspace
- **WHEN** a consumer runs the target with a repository's name and remote, and no location
- **THEN** a bare repository inside the workspace, ignored by version control, holds the remote's `main`; the workspace's committed serving environment declares it; and the remote is unchanged

#### Scenario: Served after seeding
- **WHEN** an agent whose git filesystem names the seeded repository is served and pushes a commit
- **THEN** the commit is on the host repository's `main` after the remote's history, and the remote is unchanged

#### Scenario: Run again
- **WHEN** the target runs again with the same inputs
- **THEN** nothing changes

#### Scenario: An existing bare clone of the remote
- **WHEN** the location already holds a bare clone of the same remote, made by hand, that cannot serve a partial clone
- **THEN** the target adopts it, enabling partial clones, and declares it

#### Scenario: Something else at the location
- **WHEN** the location holds a working clone, another directory, or a bare repository of another remote
- **THEN** the target fails, naming the path, and changes nothing there

#### Scenario: A remote with credentials in it
- **WHEN** the remote's URL carries a user name or password, or is not `https://`
- **THEN** the target fails before cloning, and writes nothing

#### Scenario: A declaration that would not be seen
- **WHEN** a project's own serving environment, or the workspace's local one, declares repositories without this one, so that a project's local serving would not see it
- **THEN** the target fails, naming that file

#### Scenario: A reading clone
- **WHEN** the target is given a reading clone that is absent, or that exists and shares a commit with the host repository
- **THEN** the reading clone's `origin` is the host repository, and a fetch there brings an agent's pushed commit

#### Scenario: A reading clone of another history
- **WHEN** the reading clone shares no commit with the host repository
- **THEN** the target fails, naming the reading clone, and leaves it unchanged

#### Scenario: No credential written
- **WHEN** the target has seeded a repository from a remote the host is authenticated to
- **THEN** no file the target wrote, no git configuration it set, and none of its output contains a credential
