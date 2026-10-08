# Spec Delta

## ADDED Requirements

### Requirement: Adopting AgentForge before it is published
AgentForge SHALL produce, from its own build, a single installable archive of exactly the package it would publish. A workspace SHALL be able to adopt AgentForge by depending on that archive by its absolute path, after which the initialisation, every generator, sync and every build behave as they do for a published version. Installed this way, AgentForge's peers SHALL resolve from the consumer's workspace, so the consumer and AgentForge share one copy of each. Every manifest the plugin generates SHALL depend on AgentForge by the same specifier as the workspace's root. A newer archive SHALL reach the workspace when it is installed again, with no other step before sync.

#### Scenario: A workspace outside AgentForge adopts the archive
- **WHEN** a workspace created apart from AgentForge depends on the archive by its absolute path and runs the initialisation
- **THEN** it generates an agentic project with an agent, and a workflow project connected to it, builds the agent's images and the worker, typechecks, and its sync check passes

#### Scenario: One copy of each peer
- **WHEN** the consumer's code and AgentForge's both use a peer AgentForge declares
- **THEN** both use the copy the consumer's workspace installed

#### Scenario: A generated manifest
- **WHEN** a generator writes a manifest that depends on AgentForge
- **THEN** it depends on it by the absolute path the root declares

#### Scenario: A newer archive
- **WHEN** AgentForge produces a newer archive at the same path and the workspace installs it again
- **THEN** the workspace has the newer package, and sync brings what AgentForge maintains to it
