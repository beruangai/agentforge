## ADDED Requirements

### Requirement: A transport to a local container found by name
The client SHALL provide a transport to a local container named by the caller, finding where the container listens on each call, so a caller needs no port. A container that is not running SHALL fail the call, naming the container.

#### Scenario: A served container
- **WHEN** a caller builds a transport for a running container's name and calls through it
- **THEN** the call reaches that container, even after it was restarted on another port

#### Scenario: A container that is not running
- **WHEN** a caller calls through a transport whose container is not running
- **THEN** the call fails, naming the container

### Requirement: Transports resolved from a deployment's runtime configuration
The client SHALL resolve an AgentCore transport for each named agent from the runtime configuration a deployment registers, reading it once. An agent absent from the configuration, or registered without a runtime, SHALL fail the resolution, naming the agent and its key, and no transport SHALL be returned for any agent.

#### Scenario: Every agent registered
- **WHEN** a caller resolves transports for agents the configuration registers
- **THEN** it receives a transport per agent, each reaching that agent's runtime

#### Scenario: An agent missing
- **WHEN** one named agent is absent from the configuration
- **THEN** resolution fails, naming the agent and its key

#### Scenario: An agent registered without a runtime
- **WHEN** a named agent's entry in the configuration carries no runtime
- **THEN** resolution fails, naming the agent and its key

#### Scenario: The configuration cannot be read
- **WHEN** the caller may not read the configuration, or it does not exist
- **THEN** resolution fails with the configuration service's error
