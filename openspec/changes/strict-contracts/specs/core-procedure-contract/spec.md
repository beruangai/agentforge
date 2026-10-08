## ADDED Requirements

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
