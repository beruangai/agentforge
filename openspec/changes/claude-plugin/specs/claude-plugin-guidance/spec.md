# Spec Delta

## Purpose
Guides a consumer's Claude Code in developing agentic projects with AgentForge, through a Claude Code plugin that ships inside the installed package and stays current with it (§REQ712).

## ADDED Requirements

### Requirement: The package ships a plugin marketplace
The installed package SHALL be a Claude Code plugin marketplace named `agentforge`, listing one plugin, `agentforge`, whose files are inside the package. A consumer registering the package directory as a marketplace SHALL get that plugin with no other download, and the published package SHALL carry the same marketplace as the workspace package.

#### Scenario: Registered from an installed package
- **WHEN** a developer registers the installed package's directory as a marketplace
- **THEN** Claude Code lists the marketplace `agentforge` with the plugin `agentforge`, and validates both

#### Scenario: The published package
- **WHEN** the package is built for publishing
- **THEN** the built package holds the marketplace and the plugin, and registering it gives the same plugin as the workspace package

### Requirement: Registered per machine, enabled per project
The plugin SHALL be loaded only in a project that enables it. A developer SHALL register the marketplace once per machine at user scope, with the plugin disabled there; a project SHALL enable it in its committed settings or its uncommitted local settings, and a project that does not SHALL NOT load it. Enabling SHALL need no install step beyond the registration.

#### Scenario: A project that enables it
- **WHEN** the marketplace is registered at user scope with the plugin disabled, and a project enables the plugin in its settings
- **THEN** a Claude Code session in that project loads the plugin's skill

#### Scenario: A project that does not
- **WHEN** the marketplace is registered at user scope with the plugin disabled, and a project does not enable it
- **THEN** a Claude Code session in that project does not load the plugin's skill

### Requirement: Current with the installed package
The plugin SHALL load from the installed package in place, so that installing a new version of the package changes the guidance the next session loads, with no reinstall or version bump of the plugin.

#### Scenario: A new package version
- **WHEN** the installed package's guidance changes
- **THEN** the next Claude Code session in a project that enables the plugin loads the changed guidance

### Requirement: The skill guides development with AgentForge
The plugin's skill SHALL guide a consumer's Claude Code through adopting AgentForge, generating projects, agents, workflow projects and connections, defining a contract, implementing a procedure, consuming it from a client or a workflow, and serving, testing and deploying it, and SHALL state AgentForge's known limits. It SHALL direct side effects after a successful run to the procedure's own code, chained on the run, never to a hook AgentForge provides. Every reference it makes to the package's documentation SHALL resolve inside the installed package.

#### Scenario: Asked to add a procedure
- **WHEN** a developer in a project that enables the plugin asks Claude Code to add a procedure to an agent
- **THEN** the skill is available to that session, and names how to declare the contract, compose the options and context, and run the agent

#### Scenario: A reference to the package's documentation
- **WHEN** the skill links a document
- **THEN** that document exists in the installed package at the linked path

### Requirement: Migrating across versions
The skill SHALL carry the steps to take a project from one AgentForge version to the next, one entry per version that changes what a consumer wrote or runs, newest first, each naming what breaks and what to change.

#### Scenario: Taking a new version
- **WHEN** a developer asks Claude Code to upgrade a project to the installed AgentForge version
- **THEN** the skill gives each entry newer than the project's version, with what to change
