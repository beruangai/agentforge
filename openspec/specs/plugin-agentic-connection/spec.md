# plugin-agentic-connection Specification

## Purpose
Connects an agentic project's agents to their callers and their infrastructure as one unit: a client over every agent in the project, a construct per agent registering how it is resolved, and a project construct granting a caller exactly the project's agents.

## Requirements

### Requirement: A project client over every agent
Each agentic project SHALL provide a client over all its agents, typed by their contracts, that a caller imports by the project's package name and builds once from a mapping of agent to runtime: local containers found by their names, AgentCore runtimes resolved from the deployment's runtime configuration, or transports the caller supplies (see [client-task-calls](../client-task-calls/spec.md)). Naming an agent the project does not have SHALL fail at compile time.

#### Scenario: Local and deployed alike
- **WHEN** a caller builds the project client for local containers, and again from a deployment's runtime configuration
- **THEN** the same calls reach each agent in both, typed by its contract

#### Scenario: A Temporal activity from the project client
- **WHEN** a caller gives one of the project client's procedures to the Temporal activity
- **THEN** the activity runs it as it runs any procedure

#### Scenario: An agent the project lacks
- **WHEN** a caller names an agent that is not a component of the project
- **THEN** the call fails to compile

### Requirement: Each agent's construct registers how it is resolved
Each agent SHALL have a construct deploying it as its own AgentCore runtime (see [infra-agent-runtime](../infra-agent-runtime/spec.md)), built from its image and redeployed whenever a layer below it changes, and registering its runtime in the deployment's runtime configuration under a key naming the project and the agent. Synthesising it before the image it builds on exists SHALL fail, naming the build that produces it.

#### Scenario: A deployed agent
- **WHEN** a consumer deploys an agent's construct
- **THEN** the agent runs in its own runtime, and the runtime configuration resolves it by its key

#### Scenario: A base-layer change
- **WHEN** only the project's base layer changed and the project is deployed
- **THEN** every agent is redeployed on the new base

#### Scenario: A parent image never built
- **WHEN** an agent's construct is synthesised before the image it builds on exists
- **THEN** synthesis fails, naming the build that produces it

### Requirement: An agent's construct requires exactly the secrets its layers declare
Each layer SHALL declare the secrets it requires, by the environment variable each becomes: AgentForge its subscription token, the project's base layer what every agent requires, and each agent what it alone requires, in a declaration the consumer edits. An agent's construct SHALL fail to compile unless it is given a secret for each secret AgentForge, its base layer and the agent require. A secret one agent declares SHALL NOT be required of another.

#### Scenario: A secret the agent declares
- **WHEN** an agent declares a secret and its construct is given only AgentForge's
- **THEN** the consumer's infrastructure fails to compile, naming the missing secret

#### Scenario: A secret the base layer declares
- **WHEN** the base layer declares a secret
- **THEN** every agent's construct requires it

#### Scenario: A secret another agent declares
- **WHEN** one agent declares a secret
- **THEN** no other agent's construct requires it

### Requirement: A project construct grants a caller exactly the project's agents
Each agentic project SHALL have a construct wrapping its agents' constructs, which provisions what the project's agents share (see [infra-agent-runtime](../infra-agent-runtime/spec.md)) once, through which a consumer sets the shared options — what happens to retained state when it is removed, and how long transcripts are kept — and each agent's runtime options, and which grants a caller invocation of exactly the project's agents — no other runtime — and read of the stage's runtime configuration that resolves them. The plugin SHALL NOT place any construct in the consumer's infrastructure; the consumer declares them.

#### Scenario: A granted caller
- **WHEN** a consumer grants a caller role through the project construct
- **THEN** the role may invoke each of the project's runtimes and read the stage's runtime configuration, and may invoke no other runtime

#### Scenario: Shared options set once
- **WHEN** a consumer sets a project's transcript retention through its construct
- **THEN** it applies to every agent of the project, and no agent's options take it
