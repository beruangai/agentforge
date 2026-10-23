## MODIFIED Requirements

### Requirement: An agent and its callers have least privilege
A deployed agent SHALL read only the secrets it declares, into its environment before any task runs, and SHALL refuse a declared secret also set as a plain value. Its declared secrets SHALL include every secret its project's framework requires (see [harness-framework](../harness-framework/spec.md)); for `claude`, that is the subscription token. A request SHALL fail while any secret the agent's framework or layers require is unset. A caller SHALL be granted invocation of exactly the agents it is given, and nothing else.

#### Scenario: Declared secrets alone
- **WHEN** an agent declares secrets
- **THEN** it can read those secrets and no other, and its tasks see each in the variable it names

#### Scenario: A secret also set as a plain value
- **WHEN** a consumer declares a secret and also sets the same variable as a plain value
- **THEN** the construct refuses it

#### Scenario: No subscription token
- **WHEN** a consumer declares a `claude` agent's secrets without the subscription token
- **THEN** the construct refuses it, naming it

#### Scenario: A required secret unset
- **WHEN** a secret the agent's framework or layers require is unset once the declared secrets are read
- **THEN** the request fails, naming it, and no task starts

#### Scenario: A caller granted one agent
- **WHEN** a caller is granted invocation of an agent
- **THEN** it may invoke that agent and no other
