# Spec Delta

## Purpose
Guides a consumer's Claude Code in developing agentic projects with AgentForge, through a Claude Code plugin that AgentForge maintains and distributes from its own repository, current with the source a developer registers (§REQ712).

## ADDED Requirements

### Requirement: The repository is a plugin marketplace
The AgentForge repository SHALL be a Claude Code plugin marketplace named `agentforge`, listing one plugin, `agentforge`, whose files are inside the repository. A developer registering the repository — from a local checkout, or from its git host — SHALL get that plugin with nothing else to download.

#### Scenario: Registered from a local checkout
- **WHEN** a developer registers a local checkout of the repository as a marketplace
- **THEN** Claude Code lists the marketplace `agentforge` with the plugin `agentforge`, and validates both

### Requirement: Registered per machine, enabled per project
The plugin SHALL be loaded only in a project that enables it. A developer SHALL register the marketplace once per machine at user scope, with the plugin disabled there; a project SHALL enable it in its committed settings or its uncommitted local settings, and a project that does not SHALL NOT load it. Enabling SHALL need no step beyond the registration.

#### Scenario: A project that enables it
- **WHEN** the marketplace is registered at user scope with the plugin disabled, and a project enables the plugin in its settings
- **THEN** a Claude Code session in that project loads the plugin's skill

#### Scenario: A project that does not
- **WHEN** the marketplace is registered at user scope with the plugin disabled, and a project does not enable it
- **THEN** a Claude Code session in that project does not load the plugin's skill

### Requirement: Current with the registered source
The plugin SHALL load the guidance of the source the developer registered, so that a change to that source reaches the next session with no reinstall or version bump of the plugin.

#### Scenario: The local checkout changes
- **WHEN** the guidance in a registered local checkout changes
- **THEN** the next Claude Code session in a project that enables the plugin loads the changed guidance

### Requirement: The skill guides development with AgentForge
The plugin's skill SHALL guide a consumer's Claude Code through adopting AgentForge, generating projects, agents, workflow projects and connections, defining a contract, implementing a procedure, consuming it from a client or a workflow, and serving, testing and deploying it, and SHALL state AgentForge's known limits. It SHALL direct side effects after a successful run to the procedure's own code, chained on the run, never to a hook AgentForge provides. Every file it links SHALL be inside the plugin, and for what AgentForge generates and maintains it SHALL direct Claude Code to the documentation of the AgentForge version the project installed.

#### Scenario: Asked to add a procedure
- **WHEN** a developer in a project that enables the plugin asks Claude Code to add a procedure to an agent
- **THEN** the skill is available to that session, and names how to declare the contract, compose the options and context, and run the agent

#### Scenario: A link in the skill
- **WHEN** the skill or one of its references links a file
- **THEN** that file exists inside the plugin

### Requirement: Migrating across versions
The skill SHALL carry the steps to take a project from one AgentForge version to the next, one entry per change set that alters what a consumer wrote or runs, newest first, each naming what breaks and what to change.

#### Scenario: Taking a new version
- **WHEN** a developer asks Claude Code to upgrade a project to the installed AgentForge version
- **THEN** the skill gives each entry newer than the project's version, with what to change
