# Spec Delta

## Purpose

Lets a consumer's agents persist and share files beyond one container: a bucket the consumer declares, of which a task opens one prefix, synced as the procedure declares and pushed before its outcome is published.

## ADDED Requirements

### Requirement: A working directory is declared once and shared by name
A consumer SHALL declare a working directory as a bucket that is private, TLS-only, S3-encrypted and versioned, and SHALL give it to any number of agents under a name. An agent SHALL be able to open only the working directories declared to it.

#### Scenario: Two agents share one working directory
- **WHEN** one working directory is given to two agents under the name `notebook`
- **THEN** both agents' procedures can open `notebook`, and both read and write the same bucket

#### Scenario: An undeclared name is refused
- **WHEN** a procedure opens a name that was not declared to its agent
- **THEN** the task fails `EXECUTION_ERROR`, naming the working directories that are declared

### Requirement: A procedure opens one prefix, contained to it
A procedure SHALL open a working directory at a prefix of its choosing, and SHALL receive a local directory holding that prefix. The prefix SHALL be relative, and no sync SHALL read, write or delete anything outside it. A name SHALL be opened at most once per task.

#### Scenario: A prefix that climbs is refused
- **WHEN** a procedure opens a prefix that is absolute or contains `..`
- **THEN** the task fails `EXECUTION_ERROR`, and nothing is pulled

### Requirement: The sync is declared whole, with no default
A procedure SHALL declare every part of the sync: `pull`, `push` (`NEVER`, `WHEN_COMPLETED`, `WHEN_ENDED`), `continuous` (off, or every N seconds skipping files changed in the last M seconds), `deletes` and `exclude` (regular expressions over paths relative to the prefix). AgentForge SHALL supply no default for any part. A declaration that could lose files unintentionally SHALL be refused.

#### Scenario: A missing part is refused
- **WHEN** a procedure omits any part of the sync
- **THEN** the task fails `EXECUTION_ERROR` before anything is pulled

#### Scenario: Deletes need a pull and a prefix
- **WHEN** a procedure declares `deletes` without `pull`, or on an empty prefix
- **THEN** the task fails `EXECUTION_ERROR` before anything is pulled

#### Scenario: Continuous pushes need a push whenever the task ends
- **WHEN** a procedure declares `continuous` with a `push` other than `WHEN_ENDED`
- **THEN** the task fails `EXECUTION_ERROR`

#### Scenario: An excluded file is neither pushed nor deleted
- **WHEN** a push with `deletes` runs over a prefix holding an excluded object the task does not have
- **THEN** the excluded object remains, and no excluded local file is uploaded

### Requirement: The outcome waits for a verified push
When a task ends, AgentForge SHALL push each directory the declaration covers — `WHEN_COMPLETED` and `WHEN_ENDED` on completion, `WHEN_ENDED` on failure, nothing on cancellation — and SHALL publish the outcome only after the push is verified. A task SHALL never report `TASK_STATE_COMPLETED` over a push that was not verified. The local copy SHALL be removed when the task ends.

#### Scenario: A completed task's files are in the bucket before its outcome
- **WHEN** a procedure writes a file to its working directory and completes
- **THEN** when the caller sees `TASK_STATE_COMPLETED`, another container opening the same prefix with `pull` receives the file

#### Scenario: A push that fails fails a completed task
- **WHEN** a completed task's push fails or cannot be verified
- **THEN** the task ends `TASK_STATE_FAILED` with cause `WORKING_DIRECTORY_UNSYNCED`, retryable

#### Scenario: A push that fails keeps a failed task's cause
- **WHEN** a failed task's `WHEN_ENDED` push fails
- **THEN** the task keeps its own cause, and the push's failure is added to the cause's message

#### Scenario: A cancelled task pushes nothing
- **WHEN** a task is cancelled
- **THEN** no push runs, and the bucket holds only what continuous pushes wrote before the cancel

#### Scenario: A pull that fails fails the task
- **WHEN** the pull of an opened prefix fails
- **THEN** the task ends `TASK_STATE_FAILED` with cause `WORKING_DIRECTORY_UNSYNCED`
