# core-procedure-contract Specification

## Purpose
Makes a procedure a typed contract a caller compiles against: importable without agent code, refused by a container that does not serve it, and delivered only as a conforming output.

## Requirements

### Requirement: A contract is what a caller imports, and carries no agent code
A procedure SHALL be declared as a typed contract — its input, its output and its time budget — that a caller imports and compiles against without importing the agent, the server or the Agent SDK.

#### Scenario: A caller's build cannot reach agent code
- **WHEN** a caller imports a contract and the client without opting into the agent's environment
- **THEN** the agent and server code do not resolve for it

### Requirement: A container refuses a contract it does not serve, before any work
A container SHALL refuse, before any work and naming what it could not resolve, a task whose procedure it does not have, whose contract shape differs from the one it implements, or whose input its contract refuses. Only the shape of the input and output SHALL decide compatibility; a change to the contract's meta, such as its time budget, SHALL NOT.

#### Scenario: A caller compiled against a different contract
- **WHEN** a caller starts a task with a contract whose input or output shape differs from the container's
- **THEN** the task ends `TASK_STATE_REJECTED` with the reason, and no procedure code runs

#### Scenario: An unknown procedure or malformed input
- **WHEN** a task names a procedure the container does not have, or carries input its contract refuses
- **THEN** the task ends `TASK_STATE_REJECTED` with the reason

#### Scenario: A changed time budget stays compatible
- **WHEN** a contract's declared time budget changes and its shape does not
- **THEN** a caller compiled against either version is served

### Requirement: An output is delivered only if it conforms
A task SHALL complete only with an output that conforms to its procedure's contract. A non-conforming output SHALL fail the task with `OUTPUT_INVALID`, the offending payload preserved, and an outcome too large to carry SHALL fail with `OUTPUT_TOO_LARGE` — never coerced, truncated or dropped.

#### Scenario: A procedure returns what its contract refuses
- **WHEN** a procedure's handler returns an output its contract refuses
- **THEN** the task ends `TASK_STATE_FAILED` with cause `OUTPUT_INVALID`, not retryable, carrying the payload

#### Scenario: An outcome too large to carry
- **WHEN** a procedure's output is larger than an outcome may be
- **THEN** the task ends `TASK_STATE_FAILED` with cause `OUTPUT_TOO_LARGE`, suggesting references rather than content

### Requirement: A contract never drops an undeclared field silently
A procedure contract SHALL declare, for every object in its input and its output, whether a key it does not name is refused or kept. A contract containing an object that would silently drop such a key SHALL be refused, before any of its procedures runs in an agent and before a caller calls it, naming the procedure, whether it is the input or the output, and where in it the object is. An object that refuses undeclared keys SHALL refuse a value carrying one; an object that keeps them SHALL deliver them.

#### Scenario: An object that would drop keys
- **WHEN** an agent is implemented, or a client created, from a contract whose output holds, inside a list, an object that drops keys it does not name
- **THEN** it is refused, naming the procedure, the output and the object's place in it, and no task of the agent runs its handler

#### Scenario: A handler returns an undeclared field
- **WHEN** a procedure whose output refuses undeclared keys returns one
- **THEN** the task ends `TASK_STATE_FAILED` with cause `OUTPUT_INVALID`, carrying the payload with the field

#### Scenario: Undeclared keys kept by choice
- **WHEN** a contract's object explicitly keeps undeclared keys, and a value carries one
- **THEN** the contract is accepted, and the key reaches the other side
