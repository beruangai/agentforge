# infra-agent-runtime Specification

## Purpose
Deploys an agent with one construct: serving when the deploy returns, least-privileged, its transcripts private, its filesystem storage shareable.

## Requirements

### Requirement: One construct deploys an agent that serves when the deploy returns
A consumer SHALL deploy an agent image with one construct, within its project: the project's task state, session storage, dashboard and readiness check SHALL be provisioned once for every agent of the project, and the agent's construct SHALL provision the agent's runtime and connect it to them. What AgentForge provisions SHALL be owned by AgentForge's constructs. A deploy SHALL return only once every agent it changed serves tasks, and every container of a deployed agent SHALL mint distinct ids.

#### Scenario: A deploy that returns serves
- **WHEN** a consumer deploys an agent
- **THEN** once the deploy returns, the agent runs a procedure to its typed output

#### Scenario: Two agents, one set of shared resources
- **WHEN** a consumer deploys a project with two agents
- **THEN** both record their tasks in one task store and their transcripts in one session store, and appear on one dashboard

#### Scenario: Containers restored from one image mint distinct ids
- **WHEN** several containers of one deployed agent start tasks
- **THEN** every id they mint is distinct

#### Scenario: What the construct owns
- **WHEN** a consumer sets a value the construct provisions itself, such as the task store's name or the agent's name
- **THEN** the construct refuses it

### Requirement: An agent and its callers have least privilege
A deployed agent SHALL read only the secrets it declares, into its environment before any task runs, and SHALL refuse a declared secret also set as a plain value. Its declared secrets SHALL include AgentForge's subscription token, and a request SHALL fail while any secret the agent's layers require is unset. A caller SHALL be granted invocation of exactly the agents it is given, and nothing else.

#### Scenario: Declared secrets alone
- **WHEN** an agent declares secrets
- **THEN** it can read those secrets and no other, and its tasks see each in the variable it names

#### Scenario: A secret also set as a plain value
- **WHEN** a consumer declares a secret and also sets the same variable as a plain value
- **THEN** the construct refuses it

#### Scenario: No subscription token
- **WHEN** a consumer declares an agent's secrets without the subscription token
- **THEN** the construct refuses it

#### Scenario: A required secret unset
- **WHEN** a secret the agent's layers require is unset once the declared secrets are read
- **THEN** the request fails, naming it, and no task starts

#### Scenario: A caller granted one agent
- **WHEN** a caller is granted invocation of an agent
- **THEN** it may invoke that agent and no other

### Requirement: Session transcripts are private and kept as long as the consumer chooses
A project's session transcripts SHALL be stored privately — encrypted, never public, reachable only over TLS — and kept for a retention the consumer chooses for the project, 30 days by default.

#### Scenario: The default retention
- **WHEN** a consumer deploys a project without choosing a retention
- **THEN** its agents' transcripts are private and expire after 30 days

#### Scenario: A chosen retention
- **WHEN** a consumer chooses a retention for a project
- **THEN** every one of its agents' transcripts expires after that retention

### Requirement: Filesystem storage is shared across agents
A filesystem's store SHALL be declared once and shared by any agents the consumer grants it to; each agent SHALL be able to read and write exactly the stores it declares. A store whose integrity a sync could not verify SHALL be refused.

#### Scenario: Two agents share a store
- **WHEN** a consumer declares a filesystem store and grants it to two agents
- **THEN** both can read and write it, and neither can reach a store it did not declare

#### Scenario: A store a sync could not verify
- **WHEN** a consumer declares a filesystem store encrypted in a way that defeats sync verification
- **THEN** the construct refuses it

### Requirement: An agent's tasks and transcripts are its own within its project
Within the resources its project shares, an agent SHALL answer for only its own tasks: a task SHALL record which agent ran it, and a request to an agent for a task another agent ran SHALL be answered as an unknown task. An agent SHALL store its transcripts apart from other agents', SHALL be able to read and write only its own, and a session SHALL resume only in the agent that started it.

#### Scenario: Another agent's task
- **WHEN** a caller asks one agent of a project for a task another agent of the project ran, or asks it to cancel one
- **THEN** the task is reported unknown, and the other agent's task is unchanged

#### Scenario: Another agent's transcript
- **WHEN** an agent's run resumes a session another agent of the project started
- **THEN** the session is not found, and the other agent's transcript is unchanged
