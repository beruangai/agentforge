## MODIFIED Requirements

### Requirement: An idempotency key names one logical execution
A start SHALL carry the caller's idempotency key, which names one logical execution of the agent it is sent to. A start whose key names a live or completed task of that agent SHALL attach to that task rather than start another. A new attempt SHALL start only once the key's last attempt ended otherwise, and SHALL be told its attempt number and how the last one ended. A key SHALL belong to one runtime session; a start reusing it in another SHALL be refused. One execution SHALL never run twice at once. The same key sent to two agents SHALL name two executions, even where the agents share their task state.

#### Scenario: A retry attaches
- **WHEN** a caller repeats a start with the same key while the task runs, and again after it completed
- **THEN** each start returns the same task, and the procedure runs once

#### Scenario: A new attempt after a failure
- **WHEN** a caller repeats a start whose last attempt failed, was cancelled or was lost
- **THEN** a new attempt runs, knowing its attempt number and the last attempt's state and cause

#### Scenario: A key reused in another runtime session
- **WHEN** a start reuses a key in a runtime session other than its own
- **THEN** the start is refused

#### Scenario: One key, two agents
- **WHEN** a caller starts a task with one key on one agent of a project, and with the same key on another agent of the project
- **THEN** each agent runs its own task, and neither start attaches to the other's
