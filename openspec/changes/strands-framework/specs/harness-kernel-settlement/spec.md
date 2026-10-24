## MODIFIED Requirements

### Requirement: A failed run carries a typed cause
A failed run SHALL carry a cause classified from the run's structured signals, never from its text — except where the provider documents a condition only by its message, as the Anthropic Console's spend limit is, which SHALL be classified by that documented message: an exhausted turn or spending limit is `BUDGET_EXHAUSTED`; the provider's usage or rate limit — for `claude` the subscription's — is `USAGE_LIMITED`, retryable after its reset time; a rejected credential is `CREDENTIAL_EXPIRED`; a transient provider failure is `PROVIDER_TRANSIENT`, retryable; anything else is `EXECUTION_ERROR`. A procedure SHALL be able to end its task with a cause of its own.

#### Scenario: A limit ends the run
- **WHEN** a run reaches its turn or spending limit
- **THEN** it fails with cause `BUDGET_EXHAUSTED`

#### Scenario: The usage limit
- **WHEN** a run is refused for its provider's usage or rate limit, such as a `claude` run for the subscription's
- **THEN** it fails with cause `USAGE_LIMITED`, retryable, carrying when the limit resets

#### Scenario: A procedure's own cause
- **WHEN** a procedure ends its task with a cause of its own
- **THEN** the task fails with that cause, as the procedure gave it

## ADDED Requirements

### Requirement: A claude run authenticates with the subscription
While the subscription token is in a `claude` run's environment, the CLI SHALL be given no credential it would use in its place, such as another framework's API key in the same environment, and a run that sets one in its own options SHALL fail with cause `EXECUTION_ERROR` before it starts.

#### Scenario: Another framework's key in the environment
- **WHEN** a `claude` run's environment holds both the subscription token and an Anthropic API key
- **THEN** the run authenticates with the subscription token

#### Scenario: A run sets its own API key
- **WHEN** a `claude` run sets an Anthropic API key in its own environment beside the subscription token
- **THEN** it fails with cause `EXECUTION_ERROR` before the CLI starts
