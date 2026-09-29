## ADDED Requirements

### Requirement: A temporary refusal is thrown with when to retry
The client SHALL throw a start refused as retryable as its own error, carrying the refusal's reason and the time before which a retry is pointless, distinct from every other failure. The client SHALL NOT retry it itself.

#### Scenario: A refused start
- **WHEN** an agent refuses a start as retryable
- **THEN** the client throws a refusal carrying its reason and retry time, locally and deployed alike

### Requirement: The Temporal activity waits out a temporary refusal
The Temporal activity SHALL wait out a refused start and start again under the same idempotency key, heartbeating while it waits, for a bounded total wait per attempt; once that is spent, it SHALL fail retryable, no sooner than the refusal's retry time. Cancelling the activity while it waits SHALL end the wait at once.

#### Scenario: A refusal inside the bound
- **WHEN** a start is refused and its retry time falls within the attempt's bound
- **THEN** the activity waits, heartbeating, and starts again, without failing the attempt

#### Scenario: Refusals past the bound
- **WHEN** refusals would take the attempt's waiting past its bound
- **THEN** the activity fails retryable, with its next attempt no sooner than the refusal's retry time

#### Scenario: Cancelled while waiting
- **WHEN** the workflow cancels the activity while it waits out a refusal
- **THEN** the activity ends cancelled at once, and no task was started
