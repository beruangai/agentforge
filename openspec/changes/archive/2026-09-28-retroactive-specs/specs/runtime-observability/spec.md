## ADDED Requirements

### Requirement: Agent runs are traced in the GenAI conventions
A deployed agent SHALL export telemetry of its agent runs — model calls, tool calls, subagents and their usage — over OpenTelemetry in the GenAI semantic conventions, correlated to the runtime session, and flushed before the container goes away. The consumer SHALL choose how much is exported, from errors only to full content, and a choice AgentForge does not know SHALL be refused.

#### Scenario: The consumer chooses the detail
- **WHEN** a consumer deploys an agent at a telemetry level
- **THEN** its runs export what that level includes and nothing more: content only at the levels that include it

#### Scenario: An unknown level
- **WHEN** a consumer deploys an agent at a level AgentForge does not know
- **THEN** the agent refuses to start its telemetry, and no task runs unobserved

#### Scenario: Runs read as GenAI operations
- **WHEN** a deployed agent's run calls the model and a tool
- **THEN** its spans name the operation, the model or tool, and the token usage in the GenAI conventions, stamped with the runtime session

### Requirement: What AgentForge cannot rule out is counted per agent
A deployed agent SHALL count, per agent, each container stopped with a task mid-turn, each task that outlived its grace after a stop, each task lost, and each outcome that could not be recorded — and SHALL show them on one dashboard beside what the platform reports for that agent. A count that cannot be published SHALL still be logged, and SHALL NOT change the task's outcome.

#### Scenario: A lost task is counted once
- **WHEN** a task is found lost, and read again afterwards
- **THEN** it is counted once

#### Scenario: One dashboard per agent
- **WHEN** a consumer deploys an agent
- **THEN** it has a dashboard with AgentForge's counts beside the platform's invocations, errors, latency, sessions and resources

#### Scenario: A count that cannot be published
- **WHEN** a count cannot be published
- **THEN** it is logged as an error, and the task's outcome is unchanged
