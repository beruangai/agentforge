## MODIFIED Requirements

### Requirement: An agent's construct requires exactly the secrets its layers declare
Each layer SHALL declare the secrets it requires, by the environment variable each becomes:
- the project's framework, what its runs need (for `claude`, the subscription token);
- the project's base layer, what every agent requires;
- each agent, what it alone requires, in a declaration the consumer edits.

An agent's construct SHALL fail to compile unless it is given a secret for each secret the framework, its base layer and the agent require. A secret one agent declares SHALL NOT be required of another.

#### Scenario: A secret the agent declares
- **WHEN** an agent declares a secret and its construct is given only the framework's
- **THEN** the consumer's infrastructure fails to compile, naming the missing secret

#### Scenario: The framework's secret
- **WHEN** a `claude` project's agent construct is given no subscription token
- **THEN** the consumer's infrastructure fails to compile, naming it

#### Scenario: A secret the base layer declares
- **WHEN** the base layer declares a secret
- **THEN** every agent's construct requires it

#### Scenario: A secret another agent declares
- **WHEN** one agent declares a secret
- **THEN** no other agent's construct requires it
