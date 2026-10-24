## MODIFIED Requirements

### Requirement: Generating an agentic project
The plugin SHALL generate an agentic project holding a base layer and no agents. The base layer's modules SHALL be importable by one package name, the same in the consumer's workspace and inside every agent's image, and its framework's configuration — for a `claude` project its Claude configuration: instructions, skills, subagents and settings, scaffolded as placeholders — SHALL compose into every agent's session. Generating a project that exists SHALL change nothing in a synced workspace.

#### Scenario: A new project
- **WHEN** a consumer generates an agentic project
- **THEN** it has a base layer with its framework's placeholder configuration — Claude configuration for a `claude` project — a target building its image, and no agents

#### Scenario: Generated again
- **WHEN** the same project is generated again in a synced workspace
- **THEN** nothing in the workspace changes

#### Scenario: A name that collides
- **WHEN** a consumer generates an agentic project where a different project exists
- **THEN** generation fails, naming the collision, and writes nothing

### Requirement: A generated project fences reads by default
The base layer's options a generated `claude` project scaffolds SHALL turn on Claude Code's fence on reads outside a run's working directories, so every agent of the project runs fenced unless a procedure turns it off.

#### Scenario: A new project's agents run fenced
- **WHEN** a `claude` agentic project is generated and an agent's procedure composes its options over the base layer's
- **THEN** the run's settings fence reads outside its working directories

#### Scenario: A procedure turns the fence off
- **WHEN** a procedure composes options that turn the fence off over the base layer's
- **THEN** its run is not fenced
