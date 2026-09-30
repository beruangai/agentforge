# plugin-workflow-project Specification

## Purpose
Generates and maintains a workflow project — its workflows, its own activities and one worker — whose worker connects as its environment names, runs prebuilt workflows, hands running activities on when stopped, and runs locally against the Temporal server every project on the machine shares.

## Requirements

### Requirement: Generating a workflow project
The plugin SHALL generate a workflow project holding a placeholder workflow, a placeholder activity, a unit test running the placeholder workflow, and one worker, with no connections. Every artifact it creates SHALL be maintained or scaffolded, and detachable when maintained, under the same contract as an agentic project's (see [plugin-agentic-project](../plugin-agentic-project/spec.md)). Generating a project that exists SHALL change nothing in a synced workspace.

#### Scenario: A new project
- **WHEN** a consumer generates a workflow project
- **THEN** it has a placeholder workflow and activity, a passing unit test of the workflow, a worker, and no connections

#### Scenario: Generated again
- **WHEN** the same workflow project is generated again in a synced workspace
- **THEN** nothing in the workspace changes

#### Scenario: A name that collides
- **WHEN** a consumer generates a workflow project where a different project exists
- **THEN** generation fails, naming the collision, and writes nothing

#### Scenario: A scaffolded workflow edited, a maintained worker drifted
- **WHEN** a consumer edits the placeholder workflow and the worker entry, and sync runs
- **THEN** the workflow keeps the edit and the worker entry is restored, unless the consumer detached it

### Requirement: The worker connects as its environment names
The worker SHALL connect to the Temporal namespace and address its environment names, with the API key when one is given, and SHALL read no connection profile from a file. It SHALL fail at start, naming each, when the address or namespace is unset, when a secret the project declares is unset, or when an API key is given for a local address.

#### Scenario: A local server
- **WHEN** the worker's environment names a local address and a namespace, and no API key
- **THEN** it polls that namespace on the local server

#### Scenario: Temporal Cloud
- **WHEN** the environment names a Temporal Cloud namespace, its address and an API key
- **THEN** the worker connects over TLS with that key

#### Scenario: Unset
- **WHEN** the address, the namespace or a secret the project declares is unset
- **THEN** the worker fails at start, naming each unset variable

#### Scenario: A key for a local address
- **WHEN** an API key is given with a local address
- **THEN** the worker fails at start, naming the conflict

### Requirement: The worker runs prebuilt workflows and its project's activities
The worker SHALL run the project's workflows from code bundled before it starts, by the SDK version it runs, and SHALL poll one task queue named for the project with the project's own activities and every connected agentic project's activities. A missing workflow bundle SHALL fail the start, naming the build that produces it; an activity name registered twice SHALL fail the start, naming it.

#### Scenario: A workflow started on the task queue
- **WHEN** a caller starts one of the project's workflows on its task queue
- **THEN** the worker runs it, with every activity it calls

#### Scenario: No bundle
- **WHEN** the worker starts before its workflows were bundled
- **THEN** it fails, naming the build that produces the bundle

#### Scenario: A consumer's activity named as an agent's
- **WHEN** a consumer's activity has the name of a connected agent's activity
- **THEN** the worker fails at start, naming it

### Requirement: A stopped worker hands running activities on
On a stop signal, the worker SHALL stop taking new tasks, give running activities a grace period to finish, and then exit; an agent's task an activity was waiting on SHALL keep running, for the activity's next attempt to attach to (see [client-task-calls](../client-task-calls/spec.md)).

#### Scenario: Stopped mid-activity
- **WHEN** the worker is stopped while an activity waits on an agent's task, and another worker takes the retry
- **THEN** the retry attaches to the same task, and the workflow completes with its output

### Requirement: The project runs locally against a local Temporal server
The project SHALL run against the local Temporal server every project on the machine shares, with its web UI, keeping workflow history and advanced visibility across restarts; a target SHALL start it when it is not running and register the namespace the worker's environment names, failing, naming the setting, when the namespace is unset. The worker served locally SHALL reach the connected agents either in local containers or deployed, as one setting chooses, and SHALL fail at start, naming the setting, when it is unset. The project's unit tests SHALL run its workflows against a Temporal server started for the run, with no credentials.

#### Scenario: The shared server is running
- **WHEN** a project's local run starts while another project's has the server up
- **THEN** it uses that server, registering its own namespace unless it exists

#### Scenario: The shared server restarts
- **WHEN** the shared server is stopped and started again
- **THEN** workflows and namespaces recorded before the stop are still there

#### Scenario: Local agents
- **WHEN** a consumer serves the worker with local agents, the agents served locally
- **THEN** a workflow started on the local server calls the agents in their containers

#### Scenario: Deployed agents
- **WHEN** a consumer serves the worker with the deployment's agents, with credentials that may invoke them
- **THEN** a workflow started on the local server calls the agents deployed on AgentCore

#### Scenario: No choice
- **WHEN** the worker is served without the setting choosing how agents are reached
- **THEN** it fails at start, naming the setting

#### Scenario: A unit test
- **WHEN** the project's unit tests run
- **THEN** each runs a workflow against a local server started for the run, with its activities stubbed
