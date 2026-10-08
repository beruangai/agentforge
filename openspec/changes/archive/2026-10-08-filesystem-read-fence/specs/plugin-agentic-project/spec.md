## ADDED Requirements

### Requirement: A generated project fences reads by default
The base layer's options a generated project scaffolds SHALL turn on Claude Code's fence on reads outside a run's working directories, so every agent of the project runs fenced unless a procedure turns it off.

#### Scenario: A new project's agents run fenced
- **WHEN** an agentic project is generated and an agent's procedure composes its options over the base layer's
- **THEN** the run's settings fence reads outside its working directories

#### Scenario: A procedure turns the fence off
- **WHEN** a procedure composes options that turn the fence off over the base layer's
- **THEN** its run is not fenced
