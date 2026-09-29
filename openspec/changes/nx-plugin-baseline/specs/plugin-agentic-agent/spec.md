## Purpose

Generates an agent as a component of its agentic project — recorded once, and wired into every artifact that spans the project's agents from that record — and builds and serves the agent's image locally.

## ADDED Requirements

### Requirement: An agent is a component of its project
The plugin SHALL generate an agent in an existing agentic project and record it as a component of that project. The agent SHALL have a contract its callers import by the project's package name, declaring one stub procedure whose handler fails its task loudly until the consumer implements it; procedures composing the base layer; a server and task entry; its own Claude configuration scaffolded as placeholders; and an image built on the project's agentic image. Every artifact that spans the project's agents SHALL be generated from the project's components, so adding an agent updates each of them. Generating an agent that exists SHALL change nothing in a synced workspace.

#### Scenario: A second agent
- **WHEN** a consumer adds a second agent to a project
- **THEN** the project's build targets, client and construct include both agents

#### Scenario: An unimplemented stub procedure
- **WHEN** a caller runs the stub procedure of a freshly generated agent
- **THEN** its task fails, naming the procedure as not implemented

#### Scenario: Generated again
- **WHEN** the same agent is generated again in a synced workspace
- **THEN** nothing in the workspace changes

#### Scenario: Not an agentic project
- **WHEN** a consumer generates an agent in a project that is not an agentic project, or with an invalid agent or procedure name
- **THEN** generation fails, naming why, and writes nothing

### Requirement: Removing an agent's record
When a consumer removes an agent's component record, sync SHALL remove the agent from every maintained artifact that spans the project's agents, and SHALL leave the agent's own files in place.

#### Scenario: A record removed
- **WHEN** a consumer removes an agent's record and sync runs
- **THEN** the project's targets, client and construct no longer include it, and its folder remains

### Requirement: An agent's image and its local serving
An agent's image SHALL be built on its project's agentic image, installing only what the agent adds, and SHALL be rebuilt whenever a layer below it changes. Serving an agent locally SHALL run its image under the agent's container name, with the task store it needs, on a port the host assigns, until stopped; stopping it SHALL remove everything it started. It SHALL fail before starting anything when the subscription credential is absent from its environment or the agent is already being served.

#### Scenario: A change in the base layer
- **WHEN** the base layer changes and an agent's image is built
- **THEN** the agentic image is rebuilt first and the agent's image is built on it

#### Scenario: Serving an agent
- **WHEN** a consumer serves an agent locally
- **THEN** the agent answers under its container name, and stopping it leaves no container behind

#### Scenario: No credential
- **WHEN** a consumer serves an agent without the subscription credential in its environment
- **THEN** serving fails before starting anything, naming the credential

#### Scenario: Already served
- **WHEN** a consumer serves an agent that is already being served
- **THEN** serving fails before starting anything, naming the running container
