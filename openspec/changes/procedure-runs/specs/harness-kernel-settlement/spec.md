## ADDED Requirements

### Requirement: A procedure's runs settle and are recorded one by one
A procedure SHALL be able to make any number of agent runs in its task, or none. Each run SHALL settle on its own agent's answer as an agent run does, and SHALL be recorded on the task. The task's outcome SHALL be what the procedure returns, not any run's answer. Once the task is cancelled, a further run SHALL NOT start.

#### Scenario: Two runs in one procedure
- **WHEN** a procedure makes one agent run, then a second with the first's answer in its prompt, and returns a value built from both
- **THEN** the task completes with the procedure's value, and its record holds both runs

#### Scenario: A procedure that makes no run
- **WHEN** a procedure returns a value without making an agent run
- **THEN** the task completes with that value, and its record holds no run

#### Scenario: A run after a cancel
- **WHEN** a task is cancelled after its procedure's first run settled, and the procedure then starts another
- **THEN** the second run does not start, and the task ends `TASK_STATE_CANCELED`

### Requirement: An answer is checked in the agent's turn
Every answer the agent submits SHALL be checked before it is accepted: against the agent contract the procedure gave the run, always, and by every stop guard the run gives — checks that must all pass. While any check fails, the submission SHALL be refused back to the agent in its turn, with every failure — the contract's and every guard's — in one denial, so the agent can fix them all and answer again. The answer that counts SHALL be the first one submitted while every check passes. When the agent's attempts are exhausted with a check still failing, the run SHALL fail with cause `OUTPUT_INVALID` carrying the last failures. A guard that throws SHALL fail the run with cause `EXECUTION_ERROR` naming its error, never pass or refuse silently.

#### Scenario: A constraint the agent's schema cannot express
- **WHEN** the agent contract requires a field to be a URL, and the agent submits a field that is not one
- **THEN** the agent is told the contract's error in its turn, answers again with a URL, and the run returns that answer

#### Scenario: The agent fixes what a guard names
- **WHEN** a guard requires a file the agent has not written, and the agent answers
- **THEN** the agent is told the guard's reason, writes the file, answers again, and the run returns that second answer

#### Scenario: Every failure at once
- **WHEN** a submission breaks the agent contract and a guard fails on it too
- **THEN** the agent receives the contract's error and the guard's reason in one denial

#### Scenario: A guard never satisfied
- **WHEN** a guard fails on every submission until the agent's attempts are exhausted
- **THEN** the run fails with cause `OUTPUT_INVALID`, and the cause carries the guard's last reason

#### Scenario: A guard that throws
- **WHEN** a guard throws while it is checked
- **THEN** the run fails with cause `EXECUTION_ERROR`, naming the guard's error
