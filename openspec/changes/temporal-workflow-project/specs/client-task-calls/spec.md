## MODIFIED Requirements

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
