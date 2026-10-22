## MODIFIED Requirements

### Requirement: A failed run carries a typed cause
A failed run SHALL carry a cause classified from the run's structured signals, never from its text: an exhausted turn or spending limit is `BUDGET_EXHAUSTED`; the provider's usage or rate limit — for `claude` the subscription's — is `USAGE_LIMITED`, retryable after its reset time; a rejected credential is `CREDENTIAL_EXPIRED`; a transient provider failure is `PROVIDER_TRANSIENT`, retryable; anything else is `EXECUTION_ERROR`. A procedure SHALL be able to end its task with a cause of its own.

#### Scenario: A limit ends the run
- **WHEN** a run reaches its turn or spending limit
- **THEN** it fails with cause `BUDGET_EXHAUSTED`

#### Scenario: The usage limit
- **WHEN** a run is refused for its provider's usage or rate limit, such as a `claude` run for the subscription's
- **THEN** it fails with cause `USAGE_LIMITED`, retryable, carrying when the limit resets

#### Scenario: A procedure's own cause
- **WHEN** a procedure ends its task with a cause of its own
- **THEN** the task fails with that cause, as the procedure gave it
