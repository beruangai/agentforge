# harness-kernel-settlement Specification

## Purpose
Turns one agent run into one settled outcome: the agent's structured answer or a typed cause, with every guardrail kept and every run recorded.

## Requirements

### Requirement: An agent run returns the agent's structured answer, or fails
An agent run SHALL return the agent's final answer as a value conforming to the agent contract the procedure gave it, with the run's session. A run that ends without a conforming answer SHALL fail; it SHALL NOT succeed with prose or a partial answer.

#### Scenario: A conforming answer
- **WHEN** the agent submits an answer that conforms to the agent contract
- **THEN** the run returns it, typed, with the session it ran in

#### Scenario: No conforming answer
- **WHEN** the agent finishes with prose, or with an answer the agent contract refuses
- **THEN** the run fails with cause `OUTPUT_INVALID`

#### Scenario: No answer at all
- **WHEN** the run ends without the agent finishing
- **THEN** the run fails with cause `EXECUTION_ERROR`, naming why

### Requirement: The outcome is the first settled answer
An agent run SHALL take the agent's first final answer as its outcome, only once the work the agent dispatched in the foreground has completed. A later answer SHALL NOT replace it.

#### Scenario: Dispatched work completes before the answer counts
- **WHEN** the agent dispatches subagents or tools and then submits its answer
- **THEN** the outcome is that answer, given after the dispatched work completed

#### Scenario: A second answer
- **WHEN** a run produces a second final answer after its first
- **THEN** the outcome is the first

### Requirement: A failed run carries a typed cause
A failed run SHALL carry a cause classified from the run's structured signals, never from its text: an exhausted turn or spending limit is `BUDGET_EXHAUSTED`; the subscription's usage limit is `USAGE_LIMITED`, retryable after its reset time; a rejected credential is `CREDENTIAL_EXPIRED`; a transient provider failure is `PROVIDER_TRANSIENT`, retryable; anything else is `EXECUTION_ERROR`. A procedure SHALL be able to end its task with a cause of its own.

#### Scenario: A limit ends the run
- **WHEN** a run reaches its turn or spending limit
- **THEN** it fails with cause `BUDGET_EXHAUSTED`

#### Scenario: The usage limit
- **WHEN** a run is refused for the subscription's usage limit
- **THEN** it fails with cause `USAGE_LIMITED`, retryable, carrying when the limit resets

#### Scenario: A procedure's own cause
- **WHEN** a procedure ends its task with a cause of its own
- **THEN** the task fails with that cause, as the procedure gave it

### Requirement: A cancelled run stops
Cancelling a task SHALL stop its agent run, and the task SHALL end `TASK_STATE_CANCELED`.

#### Scenario: Cancelled mid-turn
- **WHEN** a task is cancelled while its agent is working
- **THEN** the run stops and the task ends `TASK_STATE_CANCELED`

### Requirement: No guardrail is lost
Options composed from several parts — a house's defaults and a procedure's own — SHALL keep every guardrail each part contributes, whatever their order. A run SHALL fail before its agent's first turn if a guardrail it was given could never apply to any tool the agent has.

#### Scenario: A procedure adds to its house's guardrails
- **WHEN** a house disallows some tools and adds hooks, and a procedure disallows others and adds its own
- **THEN** the run has every disallowed tool and every hook from both

#### Scenario: A guardrail that would never fire
- **WHEN** a hook's matcher selects no tool the agent has
- **THEN** the run fails with cause `EXECUTION_ERROR` before the agent's first turn, naming the matcher

### Requirement: Every run is recorded, without credentials
Every agent run SHALL be recorded with the prompt as sent, the options as passed, its session, usage, timings and why it ended, correlated to its task. No credential SHALL appear in the record.

#### Scenario: A run's record
- **WHEN** a run ends
- **THEN** its task carries a record of it, and the prompt as sent can be found from the record

#### Scenario: Credentials stay out of the record
- **WHEN** a run's options carry credentials in its environment
- **THEN** the record names the variables and holds none of their values
