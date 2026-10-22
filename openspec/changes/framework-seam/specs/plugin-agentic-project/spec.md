## ADDED Requirements

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

## MODIFIED Requirements

### Requirement: Images are built from what the workspace installed
AgentForge's base image, its project's framework image and each project's agentic image SHALL be built from the AgentForge version the workspace installed, with the container's dependencies resolved to the versions that version was tested with, in the workspace's build graph. A project's agentic image SHALL be built on its framework's image, and the framework's image on the base. A layer's image SHALL install only what the layer adds, keeping every version a lower layer pinned. No generated build configuration SHALL name a path inside AgentForge's own source or build output.

#### Scenario: Building the agentic image
- **WHEN** a consumer builds a project's agentic image
- **THEN** AgentForge's base image is built first from the installed package, the framework's image on it, and the base layer on that installs only what it adds

#### Scenario: AgentForge's build inputs are missing
- **WHEN** the installed package lacks what the base or the framework image is built from
- **THEN** the build fails, naming what it expected
