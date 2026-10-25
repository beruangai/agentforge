# harness-session-persistence Specification

## Purpose
Lets a session outlive its container, so a later task resumes it in any container of a deployed agent — or fails rather than resume part of it.

## Requirements

### Requirement: A session resumes in any container
An agent SHALL persist every run's session beyond its container — deployed in the project's session bucket, served locally in the local store — so a later task in any container of that agent can resume it. A `claude` procedure MAY name its own session store, which is then used instead.

#### Scenario: Resumed in another container
- **WHEN** a deployed agent's container is stopped after a run, and a later task resumes that run's session
- **THEN** the session resumes in the new container with what the earlier run said and did

#### Scenario: Resumed locally from the store
- **WHEN** a served agent's container no longer holds a session's transcript, and a later task resumes it
- **THEN** the session resumes from the local store

#### Scenario: A procedure's own store
- **WHEN** a `claude` procedure names its own session store
- **THEN** its runs persist to that store, not the agent's

### Requirement: A resumed run sees the user scope a fresh run sees
A `claude` run that resumes a session from the store SHALL see the same Claude user scope as a fresh run in that container — the plugins installed and enabled there, its settings, skills, agents and instructions — though the Agent SDK resumes it in a config directory of its own (§REQ201, §REQ402).

#### Scenario: A plugin the base image installed at user scope
- **WHEN** an agent's base image installs a plugin at Claude's user scope, and a task in a container that holds no copy of a session's transcript resumes it from the store with the `user` setting source
- **THEN** the plugin loads on the resumed run as it did on the run that started the session

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
