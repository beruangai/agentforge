## Purpose

Adds AgentForge to a consumer's workspace, generates an agentic project — a shared base layer and the agents built on it — builds its images from the AgentForge version the workspace installed, and keeps what AgentForge maintains in it current with that version, except what the consumer detached (§REQ709).

## ADDED Requirements

### Requirement: Adding AgentForge to a workspace
The plugin SHALL provide an initialisation, run when AgentForge is added to a workspace, that declares the dependencies an agentic project needs within the ranges the installed AgentForge declares, and attaches the plugin's sync so that it runs before any of the plugin's build tasks. Running it again SHALL change nothing.

#### Scenario: A fresh workspace
- **WHEN** a consumer adds AgentForge to a workspace
- **THEN** the workspace declares the dependencies within AgentForge's ranges, and the sync is attached

#### Scenario: Added twice
- **WHEN** the initialisation runs again
- **THEN** nothing in the workspace changes

### Requirement: Generating an agentic project
The plugin SHALL generate an agentic project holding a base layer and no agents. The base layer's modules SHALL be importable by the project's package name both in the consumer's workspace and inside every agent's image, and its Claude configuration — instructions, skills, subagents and settings, scaffolded as placeholders — SHALL compose into every agent's session. Generating a project that exists SHALL change nothing in a synced workspace.

#### Scenario: A new project
- **WHEN** a consumer generates an agentic project
- **THEN** it has a base layer with placeholder Claude configuration, a target building its image, and no agents

#### Scenario: Generated again
- **WHEN** the same project is generated again in a synced workspace
- **THEN** nothing in the workspace changes

#### Scenario: A name that collides
- **WHEN** a consumer generates an agentic project where a different project exists
- **THEN** generation fails, naming the collision, and writes nothing

### Requirement: Images are built from what the workspace installed
The AgentForge image and each project's agentic image SHALL be built from the AgentForge version the workspace installed, with the container's dependencies resolved to the versions that version was tested with, in the workspace's build graph. A layer's image SHALL install only what the layer adds, keeping every version a lower layer pinned. No generated build configuration SHALL name a path inside AgentForge's own source or build output.

#### Scenario: Building the agentic image
- **WHEN** a consumer builds a project's agentic image
- **THEN** the AgentForge image is built first from the installed package, and the base layer on it installs only what it adds

#### Scenario: AgentForge's build inputs are missing
- **WHEN** the installed package lacks what the AgentForge image is built from
- **THEN** the build fails, naming what it expected

### Requirement: Maintained and scaffolded artifacts
Every artifact a generator creates SHALL be either maintained or scaffolded. A maintained artifact — or a maintained key within a file the consumer also edits — SHALL be what the installed AgentForge version generates from the project's components. A scaffolded artifact SHALL be written once, when absent, and never changed again by sync or any generator. Which artifacts and keys are maintained SHALL be stated in the plugin's documentation.

#### Scenario: A scaffolded file edited
- **WHEN** a consumer edits a scaffolded file and regenerates or syncs
- **THEN** the edit is kept

#### Scenario: A maintained key beside the consumer's own
- **WHEN** a manifest holds maintained keys and keys the consumer added, and sync runs
- **THEN** the maintained keys are current and the consumer's keys unchanged

### Requirement: Sync keeps maintained artifacts current
The plugin's sync SHALL report every maintained artifact that differs from what the installed AgentForge version generates, and restore it; checking without writing SHALL fail while any differs. Regenerating and syncing SHALL produce the same artifacts.

#### Scenario: A maintained artifact drifted
- **WHEN** a maintained artifact is edited, or AgentForge is upgraded, and sync runs
- **THEN** sync names the artifact and restores what the installed version generates

#### Scenario: Checked in CI
- **WHEN** a maintained artifact differs and the sync is only checked
- **THEN** the check fails, naming it

### Requirement: A consumer detaches a maintained artifact
A consumer SHALL be able to detach any maintained file or target by naming it in the project's metadata, after which neither sync nor any generator SHALL change it. A detachment naming nothing maintained SHALL fail the sync, naming it.

#### Scenario: Extending an agent's image
- **WHEN** a consumer detaches an agent's image definition and edits it
- **THEN** sync and regeneration leave it as the consumer wrote it

#### Scenario: A detachment that names nothing
- **WHEN** a detachment names no maintained artifact
- **THEN** sync fails, naming the detachment
