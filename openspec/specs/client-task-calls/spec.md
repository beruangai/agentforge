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
The client SHALL provide a Temporal activity that runs a procedure to its outcome: every retry of the activity SHALL attach to the same logical execution; it SHALL heartbeat while it waits; cancelling it SHALL cancel its task; and a failed task SHALL fail the activity with the task's cause, retryable exactly when the cause is, after the cause's retry time when it gives one.

#### Scenario: A typed output, heartbeating
- **WHEN** a workflow runs the activity
- **THEN** it returns the procedure's typed output, heartbeating the task's progress as it waits

#### Scenario: A cancelled activity
- **WHEN** the workflow cancels the activity while its task runs
- **THEN** the task is cancelled too

#### Scenario: A failure's retry guidance
- **WHEN** the task fails with a cause that is not retryable, or with one that is retryable after a reset time
- **THEN** the activity fails non-retryable, or retryable no sooner than that time
