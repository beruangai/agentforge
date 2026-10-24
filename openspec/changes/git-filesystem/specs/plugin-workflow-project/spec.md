# Spec Delta

## ADDED Requirements

### Requirement: A workflow project shares the workspace's host repositories
A workflow project SHALL have the same target as an agentic project for seeding a host repository from its remote (see [plugin-agentic-project](../plugin-agentic-project/spec.md)), with the same effect from either. Its local run SHALL see the same declared repositories, at the same locations, as every agentic project's local serving in the workspace.

#### Scenario: Seeded from the workflow project
- **WHEN** a consumer runs the seeding target from a workflow project, then serves an agent of an agentic project in the same workspace
- **THEN** the agent's git filesystem and the workflow project's local run reach the same host repository
