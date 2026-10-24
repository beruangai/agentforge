# Spec Delta

## ADDED Requirements

### Requirement: Serving an agent provides its declared repositories
Serving an agent locally SHALL give it each repository its serving environment declares (see [filesystem-git](../filesystem-git/spec.md)). A repository declared as a directory on the host SHALL be made reachable to the agent's container and kept when serving stops. A host directory that does not exist SHALL be created as an empty repository with a `main` branch, which is for a repository with no remote: serving SHALL say that it created it and name the target that seeds a host repository from a remote (see [plugin-agentic-project](../plugin-agentic-project/spec.md)). A repository declared as a remote location SHALL be passed as it is. The same procedure SHALL run against either without a change to its code.

#### Scenario: A host repository, created when absent
- **WHEN** a consumer serves an agent whose serving environment declares `vault` as a host directory that does not exist
- **THEN** the directory becomes an empty repository, serving names the seeding target for a repository with a remote, the agent's git filesystem naming `vault` pushes to it, and it remains after serving stops

#### Scenario: A host repository locally, a remote in the cloud
- **WHEN** a procedure's git filesystem names `vault`, a local serve declares `vault` as a host directory, and a deployment declares it as a remote
- **THEN** the local run pushes to the host repository and the deployment to the remote, through the same procedure
