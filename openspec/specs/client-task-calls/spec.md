# client-task-calls Specification

## Purpose
Gives a caller calls typed by the contract it imports, the same for a local container and a deployed agent, and a Temporal activity over them.

## Requirements

### Requirement: A caller's calls are typed by the contract it imports
The client SHALL give a caller, for each procedure of a contract, calls to start a task and read it, typed by that contract, and a call to cancel any task; a wrong procedure name or input shape SHALL fail at compile time. A task's output SHALL be reachable only once it completed, parsed against the caller's own contract. Waiting for an outcome SHALL poll until the task ends.

#### Scenario: A typed output
- **WHEN** a caller starts a task and waits for it
- **THEN** a completed task gives the output typed by the caller's contract, and a failed one its cause

#### Scenario: An output the caller's contract refuses
- **WHEN** a completed task's output does not conform to the caller's contract
- **THEN** reading it fails rather than returning it

### Requirement: One client for every place an agent runs
A caller SHALL reach a local container and a deployed agent through the same calls, differing only in how the client is constructed. The client SHALL absorb a deployed agent's transient refusal while it provisions a new session, and SHALL throw every other failure with its code.

#### Scenario: A new session is provisioning
- **WHEN** a deployed agent refuses a call because it is still creating the session's container
- **THEN** the client repeats the call for a bounded time, and throws the refusal only once that is spent

#### Scenario: Any other failure
- **WHEN** a deployed agent answers with any other error
- **THEN** the client throws it at once, with its code

### Requirement: A procedure runs as a Temporal activity
The client SHALL provide a Temporal activity that runs a procedure to its outcome, taking with each call the procedure's input and that call's routing — its runtime session, and optionally a continuity key, a time budget and metadata. Every retry of the activity SHALL attach to the same logical execution; it SHALL heartbeat while it waits; a cancel the workflow requests SHALL cancel its task, and any other end of an attempt — the worker shutting down, a heartbeat timeout, a pause or a reset — SHALL leave the task running for the next attempt to attach to. A failed task SHALL fail the activity with the task's cause, retryable exactly when the cause is, after the cause's retry time when it gives one.

#### Scenario: A typed output, heartbeating
- **WHEN** a workflow runs the activity with an input and a runtime session
- **THEN** it returns the procedure's typed output from a task in that runtime session, heartbeating the task's progress as it waits

#### Scenario: A cancelled activity
- **WHEN** the workflow cancels the activity while its task runs
- **THEN** the task is cancelled too

#### Scenario: A worker shutting down
- **WHEN** the worker running the activity shuts down while its task runs, and the activity is retried
- **THEN** the task is not cancelled, and the retry attaches to it

#### Scenario: A failure's retry guidance
- **WHEN** the task fails with a cause that is not retryable, or with one that is retryable after a reset time
- **THEN** the activity fails non-retryable, or retryable no sooner than that time

### Requirement: A temporary refusal is thrown with when to retry
The client SHALL throw a start refused as retryable as its own error, carrying the refusal's reason and the time before which a retry is pointless, distinct from every other failure. The client SHALL NOT retry it itself.

#### Scenario: A refused start
- **WHEN** an agent refuses a start as retryable
- **THEN** the client throws a refusal carrying its reason and retry time, locally and deployed alike

### Requirement: The Temporal activity waits out a temporary refusal
The Temporal activity SHALL wait out a refused start and start again under the same idempotency key, heartbeating while it waits, for a bounded total wait per attempt; once that is spent, it SHALL fail retryable, no sooner than the refusal's retry time. Cancelling the activity while it waits SHALL end the wait at once.

#### Scenario: A refusal inside the bound
- **WHEN** a start is refused and its retry time falls within the attempt's bound
- **THEN** the activity waits, heartbeating, and starts again, without failing the attempt

#### Scenario: Refusals past the bound
- **WHEN** refusals would take the attempt's waiting past its bound
- **THEN** the activity fails retryable, with its next attempt no sooner than the refusal's retry time

#### Scenario: Cancelled while waiting
- **WHEN** the workflow cancels the activity while it waits out a refusal
- **THEN** the activity ends cancelled at once, and no task was started

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
