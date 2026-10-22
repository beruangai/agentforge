## MODIFIED Requirements

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
