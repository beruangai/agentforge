# harness-session-persistence Specification

## Purpose
Lets a session outlive its container, so a later task resumes it in any container of a deployed agent — or fails rather than resume part of it.

## Requirements

### Requirement: A session resumes in any container
A deployed agent SHALL persist every run's session beyond its container, so a later task in any container of that agent can resume it. A procedure MAY name its own session store, which is then used instead. Locally, a session SHALL resume for as long as its container lives.

#### Scenario: Resumed in another container
- **WHEN** a deployed agent's container is stopped after a run, and a later task resumes that run's session
- **THEN** the session resumes in the new container with what the earlier run said and did

#### Scenario: Resumed locally
- **WHEN** a task resumes a session an earlier task started in the same local container
- **THEN** the session resumes

#### Scenario: A procedure's own store
- **WHEN** a procedure names its own session store
- **THEN** its runs persist to that store, not the agent's

### Requirement: A session that did not persist whole fails the run
A run SHALL fail rather than succeed over a session that did not persist whole, and resuming a session whose persisted transcript is corrupt SHALL fail rather than resume part of it.

#### Scenario: Part of the transcript was not persisted
- **WHEN** a run's session store did not accept every message the agent produced
- **THEN** the run fails with cause `EXECUTION_ERROR`, saying the session would not resume whole

#### Scenario: The store reports a failure
- **WHEN** the session store reports that it could not persist the transcript
- **THEN** the run fails with cause `EXECUTION_ERROR`

#### Scenario: A corrupt transcript
- **WHEN** a session's persisted transcript cannot be read whole
- **THEN** resuming it fails
