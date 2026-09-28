# runtime-task-admission Specification

## Purpose
Starts tasks asynchronously, one logical execution per idempotency key, refusing rather than queueing what a container cannot run.

## Requirements

### Requirement: Starting a task is asynchronous
Starting a task SHALL return the task at once, before it runs, and its outcome SHALL be read by polling. No synchronous request limit SHALL bound how long a task runs.

#### Scenario: A start returns before the work
- **WHEN** a caller starts a task
- **THEN** it receives the task in `TASK_STATE_SUBMITTED` or `TASK_STATE_WORKING`, and reads its outcome later

### Requirement: An idempotency key names one logical execution
A start SHALL carry the caller's idempotency key. A start whose key names a live or completed task SHALL attach to that task rather than start another. A new attempt SHALL start only once the key's last attempt ended otherwise, and SHALL be told its attempt number and how the last one ended. A key SHALL belong to one runtime session; a start reusing it in another SHALL be refused. One execution SHALL never run twice at once.

#### Scenario: A retry attaches
- **WHEN** a caller repeats a start with the same key while the task runs, and again after it completed
- **THEN** each start returns the same task, and the procedure runs once

#### Scenario: A new attempt after a failure
- **WHEN** a caller repeats a start whose last attempt failed, was cancelled or was lost
- **THEN** a new attempt runs, knowing its attempt number and the last attempt's state and cause

#### Scenario: A key reused in another runtime session
- **WHEN** a start reuses a key in a runtime session other than its own
- **THEN** the start is refused

### Requirement: A start is refused, never queued
A container SHALL NOT queue a start. It SHALL refuse, as `TASK_STATE_REJECTED` with the reason, a start beyond the number of tasks it runs at once, or one whose continuity key names a task still running there.

#### Scenario: Beyond the admission limit
- **WHEN** a container is running as many tasks as it admits and another start arrives
- **THEN** that task ends `TASK_STATE_REJECTED`, saying why, and the running tasks are unaffected

#### Scenario: A continuity key already running
- **WHEN** a start carries a continuity key under which a task is running in that container
- **THEN** that task ends `TASK_STATE_REJECTED`, saying why
