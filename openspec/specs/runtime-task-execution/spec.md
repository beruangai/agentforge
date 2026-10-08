# runtime-task-execution Specification

## Purpose
Runs each admitted task to one durable outcome within its time budget, stopping everything it started when cancelled and reporting it lost within a bounded time when its container goes.

## Requirements

### Requirement: A task ends in one durable outcome
Every task SHALL end in exactly one outcome — completed with its output, failed with its cause, cancelled, or rejected with its reason — held durably outside the container and the caller, so it can be read after either is gone. Once a task has ended, its outcome SHALL NOT be replaced by a different one.

#### Scenario: A later outcome does not replace an ended task
- **WHEN** a task has ended and a different outcome for it arrives later
- **THEN** the first outcome stands

#### Scenario: Read after the container is gone
- **WHEN** a task's container has stopped
- **THEN** the task's outcome can still be read

### Requirement: A task is bounded by its time budget
A task SHALL end with cause `TIMED_OUT` when it runs past its time budget — declared with the procedure, overridable per call, and otherwise the agent's default — however the task's own code behaves.

#### Scenario: The procedure's budget, or the call's
- **WHEN** a procedure declares a time budget, and one call overrides it
- **THEN** each task ends `TIMED_OUT` at the budget that applies to it

### Requirement: Cancelling stops everything the task started
Cancelling a task SHALL stop its run and every process it started, even one that ignores the cancel, and the task SHALL end `TASK_STATE_CANCELED`. Nothing the task started SHALL outlive it.

#### Scenario: A cooperative cancel
- **WHEN** a running task is cancelled
- **THEN** it ends `TASK_STATE_CANCELED` and its container is idle again

#### Scenario: A task that ignores the cancel
- **WHEN** a cancelled task and the processes it started do not stop on their own
- **THEN** they are killed after a grace period, and the task ends `TASK_STATE_CANCELED`

### Requirement: A lost task is reported within a bounded time
A task whose container dies or is stopped while it runs SHALL be reported failed with cause `LOST`, retryable, within a bounded and documented time — not at the caller's own timeout. `LOST` SHALL be distinguishable from a task that failed on its own terms, and SHALL mean its side effects may have happened.

#### Scenario: The container is stopped mid-task
- **WHEN** the platform stops a container while its task runs
- **THEN** the task is reported `LOST` within the bounded time, and a retry under its key runs as the next attempt

### Requirement: A crash is a failure with its evidence
A task that ends without an outcome SHALL fail with cause `EXECUTION_ERROR`, carrying the end of its error output.

#### Scenario: The task process crashes
- **WHEN** a task's process exits without reporting an outcome
- **THEN** the task fails `EXECUTION_ERROR`, and its cause carries the tail of what the process wrote to its error output

### Requirement: Liveness is never delayed by a task
A container SHALL report its liveness — busy while any task runs, idle otherwise — without running an agent, and nothing a task does SHALL delay that report. A busy container SHALL still accept starts, polls and cancels.

#### Scenario: Busy while a task runs
- **WHEN** a task is running
- **THEN** the container reports busy, and idle once no task runs

### Requirement: A task records the image that ran it
Every task SHALL record which image ran it — deployed, the image reference the agent was deployed with; locally, the image's id — from the moment it is admitted, and a caller reading the task SHALL receive it. Two deployments of an agent whose images differ SHALL record different references; a task SHALL keep the reference it was admitted under after the agent is redeployed. A server not told which image it runs in SHALL refuse to start.

#### Scenario: A deployed task
- **WHEN** a caller reads a task a deployed agent ran
- **THEN** it receives the image reference that agent was deployed with

#### Scenario: A local task
- **WHEN** a caller reads a task an agent served locally ran
- **THEN** it receives the id of the agent's local image

#### Scenario: Redeployed with a changed image
- **WHEN** an agent is redeployed with a changed image after a task ended
- **THEN** a new task records the new reference, and the earlier task still records its own

#### Scenario: Not told its image
- **WHEN** an agent's server starts without being told which image it runs in
- **THEN** it refuses to start, naming what is missing
