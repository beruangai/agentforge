## ADDED Requirements

### Requirement: A task records the image that ran it
Every task SHALL record which image ran it — deployed, the image reference the agent was deployed with; locally, the image's id — from the moment it is admitted, and a caller reading the task SHALL receive it. Two deployments of an agent whose images differ SHALL record different references; a task SHALL keep the reference it was admitted under after the agent is redeployed. A server not told which image it runs in SHALL refuse to start.

#### Scenario: A deployed task
- **WHEN** a caller reads a task a deployed agent ran
- **THEN** it receives the image reference that agent was deployed with

#### Scenario: A local task
- **WHEN** a caller reads a task an agent served locally ran
- **THEN** it receives the id of the agent's local image

#### Scenario: Redeployed with a changed image
- **WHEN** an agent is redeployed with a changed image after a task ended
- **THEN** a new task records the new reference, and the earlier task still records its own

#### Scenario: Not told its image
- **WHEN** an agent's server starts without being told which image it runs in
- **THEN** it refuses to start, naming what is missing
