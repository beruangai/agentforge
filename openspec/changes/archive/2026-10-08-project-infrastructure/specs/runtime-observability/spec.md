## REMOVED Requirements

### Requirement: What AgentForge cannot rule out is counted per agent
**Reason**: Each agent had a dashboard of its own; the counts now show on the project's one dashboard, in a section per agent, under the requirement added below.
**Migration**: None; no consumer is deployed. A deployed project's dashboard replaces its agents' own.

## ADDED Requirements

### Requirement: What AgentForge cannot rule out is counted per agent, on its project's dashboard
A deployed agent SHALL count, per agent, each container stopped with a task mid-turn, each task that outlived its grace after a stop, each task lost, and each outcome that could not be recorded — and SHALL show them on its project's one dashboard, in a section of its own, beside what the platform reports for that agent. A count that cannot be published SHALL still be logged, and SHALL NOT change the task's outcome.

#### Scenario: A lost task is counted once
- **WHEN** a task is found lost, and read again afterwards
- **THEN** it is counted once

#### Scenario: One dashboard per project
- **WHEN** a consumer deploys a project with two agents
- **THEN** it has one dashboard with a section per agent, each showing AgentForge's counts for that agent beside the platform's invocations, errors, latency, sessions and resources

#### Scenario: A count that cannot be published
- **WHEN** a count cannot be published
- **THEN** it is logged as an error, and the task's outcome is unchanged
