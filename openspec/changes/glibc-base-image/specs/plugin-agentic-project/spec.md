## ADDED Requirements

### Requirement: A layer extends its image beyond its manifest
A layer SHALL be able to extend its image with system packages and with native libraries its manifest cannot declare, by detaching the layer's image definition (as "A consumer detaches a maintained artifact" provides). The AgentForge image SHALL run binaries built for the GNU C library at version 2.35 or later, on ARM64, so that a library published prebuilt only for it installs without being built from source. The documented route for doing so SHALL install as root and return to the image's non-root user, so that an image extended by it still runs its server and every task as that user; a detached image definition is the consumer's, and leaving it non-root is theirs. Every agent built on the layer SHALL be able to use what the layer installed.

#### Scenario: A Python library published only prebuilt for the GNU C library
- **WHEN** a project's base layer installs Python and a library published only as prebuilt wheels for the GNU C library 2.35 or later, refusing to build any from source, and an agent on that layer runs Python importing it
- **THEN** the image builds for ARM64, and the agent's run reports the library's version, locally and on AgentCore

#### Scenario: Extended, still not root
- **WHEN** a layer installs system packages as root in its image definition and returns to the image's user, as the documented route does
- **THEN** the server and every task process in the built image run as the image's non-root user
