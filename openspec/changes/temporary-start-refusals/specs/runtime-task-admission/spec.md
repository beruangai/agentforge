## MODIFIED Requirements

### Requirement: A start is refused, never queued
A container SHALL NOT queue a start. It SHALL refuse a start it cannot run now — one beyond the number of tasks it runs at once, one whose continuity key names a task still running there, or one that arrives while it is stopping — with a retryable error that says which and when to retry: for a continuity key, no later than the running task's time budget allows it to run. A refused start SHALL create no task and bind no idempotency key, so a start repeated after it runs as a first start. A refusal SHALL reach a caller the same way whether the agent runs locally or deployed. A start whose key names a live or completed task SHALL attach to it rather than be refused.

#### Scenario: Beyond the admission limit
- **WHEN** a container is running as many tasks as it admits and another start arrives
- **THEN** the start is refused as retryable, with its reason and when to retry, no task is created, and the running tasks are unaffected

#### Scenario: A continuity key already running
- **WHEN** a start carries a continuity key under which a task is running in that container
- **THEN** the start is refused as retryable, no later than when the running task's time budget ends

#### Scenario: A container that is stopping
- **WHEN** a start arrives while its container is stopping, including one admitted as the stop began
- **THEN** the start is refused as retryable, and its idempotency key names no task

#### Scenario: A start repeated after a refusal
- **WHEN** a caller repeats a refused start with the same idempotency key once its container can run it
- **THEN** it runs as a first attempt

#### Scenario: An attach while full or stopping
- **WHEN** a start's key names a live or completed task in a container that is full or stopping
- **THEN** the start attaches to that task rather than being refused

## ADDED Requirements

### Requirement: A start too large to record is rejected
A start SHALL be rejected, as `TASK_STATE_REJECTED` with the reason, before it runs, when what it carries exceeds what a task's record can hold; the reason SHALL name the size and the cap. `TASK_STATE_REJECTED` SHALL be reserved for a start that can never succeed as sent.

#### Scenario: An oversize start
- **WHEN** a caller starts a task whose envelope exceeds the cap
- **THEN** the task ends `TASK_STATE_REJECTED`, naming its size and the cap, and no procedure code runs
