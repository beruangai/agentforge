## MODIFIED Requirements

### Requirement: A project construct grants a caller exactly the project's agents
Each agentic project SHALL have a construct wrapping its agents' constructs, which provisions what the project's agents share (see [infra-agent-runtime](../infra-agent-runtime/spec.md)) once, through which a consumer sets the shared options — what happens to retained state when it is removed, and how long transcripts are kept — and each agent's runtime options, and which grants a caller invocation of exactly the project's agents — no other runtime — and read of the stage's runtime configuration that resolves them. The plugin SHALL NOT place any construct in the consumer's infrastructure; the consumer declares them.

#### Scenario: A granted caller
- **WHEN** a consumer grants a caller role through the project construct
- **THEN** the role may invoke each of the project's runtimes and read the stage's runtime configuration, and may invoke no other runtime

#### Scenario: Shared options set once
- **WHEN** a consumer sets a project's transcript retention through its construct
- **THEN** it applies to every agent of the project, and no agent's options take it
