# Spec Delta

## ADDED Requirements

### Requirement: A deployment names the repositories its git filesystems use
A deployed agent SHALL be told, by name, the location of each repository its git filesystems may name (see [filesystem-git](../filesystem-git/spec.md)), as it is told its filesystem buckets. A repository's token SHALL be one of the agent's declared secrets, which the deployment maps without making it required, so an agent that never mounts the repository runs without it. A repository name that a filesystem name could not be SHALL be refused when the agent is declared.

#### Scenario: A repository named to the agent
- **WHEN** a consumer deploys an agent with the repository `vault` at a remote location, and its token as a secret
- **THEN** a git filesystem naming `vault` mounts from that remote with that token

#### Scenario: An invalid repository name
- **WHEN** a consumer declares a repository whose name a filesystem name could not be
- **THEN** declaring the agent fails, naming it
