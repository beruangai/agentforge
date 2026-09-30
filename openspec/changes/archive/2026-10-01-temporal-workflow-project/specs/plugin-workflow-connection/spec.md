## ADDED Requirements

### Requirement: A connection is recorded on the workflow project
The plugin SHALL connect a workflow project to an agentic project by recording the agentic project on the workflow project, and every artifact spanning the workflow project's connections SHALL be generated from those records, so a second connection adds that project everywhere. Connecting again SHALL change nothing in a synced workspace. Removing a record and syncing SHALL remove that agentic project from every maintained artifact. Connecting anything but a workflow project to an agentic project SHALL fail, naming why, and write nothing.

#### Scenario: A second agentic project
- **WHEN** a consumer connects a workflow project to a second agentic project
- **THEN** its workflows can call both projects' agents, its worker runs both projects' activities, and its construct requires and grants both

#### Scenario: Connected again
- **WHEN** the same connection is generated again in a synced workspace
- **THEN** nothing in the workspace changes

#### Scenario: A record removed
- **WHEN** a consumer removes a connection's record and sync runs
- **THEN** no maintained artifact refers to that agentic project

#### Scenario: Not a workflow project, or not an agentic project
- **WHEN** a consumer connects from a project that is not a workflow project, or to one that is not an agentic project
- **THEN** generation fails, naming why, and writes nothing

### Requirement: A workflow calls an agent's procedure typed by its contract
A workflow SHALL call each procedure of each connected agent with the procedure's input and that call's routing — its runtime session, and optionally a continuity key, a time budget and metadata — and SHALL receive the procedure's output typed by the agent's contract; a procedure the project lacks, or a wrong input, SHALL fail at compile time. The workflow's code SHALL carry none of the agentic project's code. Each call SHALL run as the procedure's activity (see [client-task-calls](../client-task-calls/spec.md)), and by default a worker lost mid-call SHALL be noticed within a minute rather than at the call's timeout. A workflow MAY set activity options for a set of calls, and each call MAY set its own, which apply to that call alone over the set's; neither SHALL set the activity's id or task queue, since a shared id would attach a later call to an earlier call's task and no other queue has a worker for the agents' activities.

#### Scenario: A typed output
- **WHEN** a workflow calls a connected agent's procedure with its input and a runtime session
- **THEN** it receives the procedure's output, typed by the agent's contract

#### Scenario: A wrong call
- **WHEN** a workflow calls a procedure the connected agent lacks, or with an input its contract refuses
- **THEN** the workflow fails to compile

#### Scenario: A lost worker
- **WHEN** the worker running a call is lost without reporting
- **THEN** the call's next attempt starts within about a minute, and attaches to the same task

#### Scenario: A call's own options
- **WHEN** a workflow gives one call a longer timeout than its set's
- **THEN** that call runs with the longer timeout, and the set's other calls keep theirs

#### Scenario: An activity id or task queue
- **WHEN** a workflow sets an activity id or a task queue, for a set of calls or for one
- **THEN** the call fails, naming the option, and schedules nothing

### Requirement: The project construct deploys the worker with exactly its connected agents
Each workflow project SHALL have a construct deploying its worker (see [infra-workflow-worker](../infra-workflow-worker/spec.md)) from its bundled worker, which SHALL require the construct of each connected agentic project and SHALL grant the worker invocation of exactly those projects' agents and read of the runtime configuration that resolves them. It SHALL fail to compile without the Temporal API key or a secret the project declares. Synthesising it before the worker is bundled SHALL fail, naming the build that produces it. The plugin SHALL NOT place the construct in the consumer's infrastructure.

#### Scenario: Granted exactly the connected agents
- **WHEN** a consumer declares a workflow project's construct with its connected projects' constructs
- **THEN** the worker may invoke each of their agents and read the runtime configuration, and may invoke no other runtime

#### Scenario: A connected project not given
- **WHEN** a consumer declares the construct without a connected project's construct
- **THEN** the consumer's infrastructure fails to compile, naming it

#### Scenario: A secret the project declares
- **WHEN** the workflow project declares a secret and its construct is given only the Temporal API key
- **THEN** the consumer's infrastructure fails to compile, naming the missing secret

#### Scenario: Not bundled
- **WHEN** the construct is synthesised before the worker is bundled
- **THEN** synthesis fails, naming the build that produces the bundle
