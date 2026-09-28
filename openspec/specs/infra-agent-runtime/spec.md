# infra-agent-runtime Specification

## Purpose
Deploys an agent with one construct: serving when the deploy returns, least-privileged, its transcripts private, its filesystem storage shareable.

## Requirements

### Requirement: One construct deploys an agent that serves when the deploy returns
A consumer SHALL deploy an agent image with one construct, which provisions everything AgentForge's server needs to run it — its task state and its session storage among them — and owns what it provisions. A deploy SHALL return only once the agent serves tasks, and every container of the deployed agent SHALL mint distinct ids.

#### Scenario: A deploy that returns serves
- **WHEN** a consumer deploys an agent
- **THEN** once the deploy returns, the agent runs a procedure to its typed output

#### Scenario: Containers restored from one image mint distinct ids
- **WHEN** several containers of one deployed agent start tasks
- **THEN** every id they mint is distinct

#### Scenario: What the construct owns
- **WHEN** a consumer sets a value the construct provisions itself, such as the task table's name
- **THEN** the construct refuses it

### Requirement: An agent and its callers have least privilege
A deployed agent SHALL read only the secrets it declares, into its environment before any task runs, and SHALL refuse a declared secret also set as a plain value. A caller SHALL be granted invocation of exactly the agents it is given, and nothing else.

#### Scenario: Declared secrets alone
- **WHEN** an agent declares secrets
- **THEN** it can read those secrets and no other, and its tasks see each in the variable it names

#### Scenario: A secret also set as a plain value
- **WHEN** a consumer declares a secret and also sets the same variable as a plain value
- **THEN** the construct refuses it

#### Scenario: A caller granted one agent
- **WHEN** a caller is granted invocation of an agent
- **THEN** it may invoke that agent and no other

### Requirement: Session transcripts are private and kept as long as the consumer chooses
A deployed agent's session transcripts SHALL be stored privately — encrypted, never public, reachable only over TLS — and kept for a retention the consumer chooses, 30 days by default.

#### Scenario: The default retention
- **WHEN** a consumer deploys an agent without choosing a retention
- **THEN** its transcripts are private and expire after 30 days

#### Scenario: A chosen retention
- **WHEN** a consumer chooses a retention
- **THEN** its transcripts expire after that retention

### Requirement: Filesystem storage is shared across agents
A filesystem's store SHALL be declared once and shared by any agents the consumer grants it to; each agent SHALL be able to read and write exactly the stores it declares. A store whose integrity a sync could not verify SHALL be refused.

#### Scenario: Two agents share a store
- **WHEN** a consumer declares a filesystem store and grants it to two agents
- **THEN** both can read and write it, and neither can reach a store it did not declare

#### Scenario: A store a sync could not verify
- **WHEN** a consumer declares a filesystem store encrypted in a way that defeats sync verification
- **THEN** the construct refuses it
