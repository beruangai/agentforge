# plugin-agentic-project Specification

## Purpose
Adds AgentForge to a consumer's workspace, generates an agentic project — a shared base layer and the agents built on it — builds its images from the AgentForge version the workspace installed, and keeps what AgentForge maintains in it current with that version, except what the consumer detached (§REQ709).

## Requirements

### Requirement: Adding AgentForge to a workspace
The plugin SHALL provide an initialisation, run when AgentForge is added to a workspace, that declares the dependencies an agentic project needs within the ranges the installed AgentForge declares, and attaches the plugin's sync so that it runs before any of the plugin's build tasks. Running it again SHALL change nothing.

#### Scenario: A fresh workspace
- **WHEN** a consumer adds AgentForge to a workspace
- **THEN** the workspace declares the dependencies within AgentForge's ranges, and the sync is attached

#### Scenario: Added twice
- **WHEN** the initialisation runs again
- **THEN** nothing in the workspace changes

### Requirement: Generating an agentic project
The plugin SHALL generate an agentic project holding a base layer and no agents. The base layer's modules SHALL be importable by one package name, the same in the consumer's workspace and inside every agent's image, and its framework's configuration — for a `claude` project its Claude configuration: instructions, skills, subagents and settings, scaffolded as placeholders — SHALL compose into every agent's session. Generating a project that exists SHALL change nothing in a synced workspace.

#### Scenario: A new project
- **WHEN** a consumer generates an agentic project
- **THEN** it has a base layer with its framework's placeholder configuration — Claude configuration for a `claude` project — a target building its image, and no agents

#### Scenario: Generated again
- **WHEN** the same project is generated again in a synced workspace
- **THEN** nothing in the workspace changes

#### Scenario: A name that collides
- **WHEN** a consumer generates an agentic project where a different project exists
- **THEN** generation fails, naming the collision, and writes nothing

### Requirement: A generated project fences reads by default
The base layer's options a generated `claude` project scaffolds SHALL turn on Claude Code's fence on reads outside a run's working directories, so every agent of the project runs fenced unless a procedure turns it off.

#### Scenario: A new project's agents run fenced
- **WHEN** a `claude` agentic project is generated and an agent's procedure composes its options over the base layer's
- **THEN** the run's settings fence reads outside its working directories

#### Scenario: A procedure turns the fence off
- **WHEN** a procedure composes options that turn the fence off over the base layer's
- **THEN** its run is not fenced

### Requirement: A generated project loads Claude's user scope
The base layer's options a generated `claude` project scaffolds SHALL load the `user` and `project` setting sources, so what the project's base image installs at Claude's user scope — a plugin, a user setting — reaches every agent's session, fresh or resumed.

#### Scenario: A new project's base options
- **WHEN** a `claude` agentic project is generated
- **THEN** its base layer's options load `settingSources: ['user', 'project']`

### Requirement: Images are built from what the workspace installed
AgentForge's base image, its project's framework image and each project's agentic image SHALL be built from the AgentForge version the workspace installed, with the container's dependencies resolved to the versions that version was tested with, in the workspace's build graph. A project's agentic image SHALL be built on its framework's image, and the framework's image on the base. A layer's image SHALL install only what the layer adds, keeping every version a lower layer pinned. No generated build configuration SHALL name a path inside AgentForge's own source or build output.

#### Scenario: Building the agentic image
- **WHEN** a consumer builds a project's agentic image
- **THEN** AgentForge's base image is built first from the installed package, the framework's image on it, and the base layer on that installs only what it adds

#### Scenario: AgentForge's build inputs are missing
- **WHEN** the installed package lacks what the base or the framework image is built from
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

### Requirement: A layer extends its image beyond its manifest
A layer SHALL be able to extend its image with system packages and with native libraries its manifest cannot declare, by detaching the layer's image definition (as "A consumer detaches a maintained artifact" provides). The AgentForge image SHALL run binaries built for the GNU C library at version 2.35 or later, on ARM64, so that a library published prebuilt only for it installs without being built from source. The documented route for doing so SHALL install as root and return to the image's non-root user, so that an image extended by it still runs its server and every task as that user; a detached image definition is the consumer's, and leaving it non-root is theirs. Every agent built on the layer SHALL be able to use what the layer installed.

#### Scenario: A Python library published only prebuilt for the GNU C library
- **WHEN** a project's base layer installs Python and a library published only as prebuilt wheels for the GNU C library 2.35 or later, refusing to build any from source, and an agent on that layer runs Python importing it
- **THEN** the image builds for ARM64, and the agent's run reports the library's version, locally and on AgentCore

#### Scenario: Extended, still not root
- **WHEN** a layer installs system packages as root in its image definition and returns to the image's user, as the documented route does
- **THEN** the server and every task process in the built image run as the image's non-root user

### Requirement: A project is generated for one framework
Generating an agentic project SHALL record the framework it is for: `claude` unless the consumer names another the installed AgentForge provides. Everything the plugin generates or maintains for the project SHALL be rendered for that framework: its layers' configuration, its base options, its secrets, its server entry and its images. A framework the installed AgentForge does not provide SHALL be refused, and nothing written. Sync SHALL refuse a project whose record names no framework, or one the installed AgentForge does not provide, naming the field and the frameworks it provides, and SHALL write nothing for it. Sync SHALL NOT assume a framework the record does not name.

#### Scenario: No framework named
- **WHEN** a consumer generates an agentic project without naming a framework
- **THEN** the project records `claude`, and its layers, options, secrets, server entry and images are rendered for it

#### Scenario: An unknown framework
- **WHEN** a consumer generates an agentic project for a framework the installed AgentForge does not provide
- **THEN** generation fails, naming the framework and those it provides, and writes nothing

#### Scenario: A project that records no framework
- **WHEN** sync runs on a project whose record names no framework
- **THEN** sync fails, naming the missing field and the frameworks AgentForge provides, and writes nothing for that project

#### Scenario: A project whose framework is not provided
- **WHEN** sync runs on a project whose record names a framework the installed AgentForge does not provide
- **THEN** sync fails, naming it and those it provides, and writes nothing for that project
