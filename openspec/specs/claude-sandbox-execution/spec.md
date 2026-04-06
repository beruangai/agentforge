# Capability: claude-sandbox-execution

## Purpose

Host-side container execution lifecycle for the `@beruangai/agentforge-claude-sandbox` package. Covers task execution in isolated Docker containers, session persistence, volume mounting, credential injection, sentinel output extraction, image management, and cleanup.

## Requirements

### Requirement: Execute agent tasks in isolated containers
The system SHALL execute agent tasks inside Docker containers, accepting task configuration (prompt, model, tools, output schema, MCP servers) and returning structured output. Each execution SHALL be independent — no shared state between executions except explicitly persisted sessions.

#### Scenario: Successful task execution
- **WHEN** a consumer calls execute with a valid prompt and model
- **THEN** the system creates a container, runs the agent task, extracts structured output, and returns it with status "success"

#### Scenario: Task execution with structured output
- **WHEN** a consumer provides a JSON Schema (draft-07) output format
- **THEN** the returned structured output conforms to the provided schema

#### Scenario: Task execution with MCP servers
- **WHEN** a consumer provides MCP server configurations (HTTP or stdio)
- **THEN** the agent inside the container can access those MCP servers during execution

### Requirement: Enforce execution timeouts
The system SHALL enforce a configurable timeout per execution. If the container exceeds the timeout, it SHALL be killed and a retryable error returned.

#### Scenario: Execution within timeout
- **WHEN** a task completes before the timeout
- **THEN** the result is returned normally

#### Scenario: Execution exceeds timeout
- **WHEN** a task exceeds the configured timeout
- **THEN** the container is killed and an error is raised indicating timeout

#### Scenario: Default timeout applies
- **WHEN** no per-execution timeout is specified
- **THEN** the runner's default timeout (configurable at construction) is used

### Requirement: Extract structured output via sentinel protocol
The system SHALL extract structured JSON output from container stdout using sentinel markers (`---AGENTFORGE_OUTPUT_START---` / `---AGENTFORGE_OUTPUT_END---`). All other stdout content (debug logs, MCP output, SDK progress) SHALL be ignored for output extraction.

#### Scenario: Valid sentinel output present
- **WHEN** container stdout contains properly delimited sentinel markers with valid JSON between them
- **THEN** the JSON is parsed and returned as the execution result

#### Scenario: No sentinel output found
- **WHEN** container stdout does not contain sentinel markers (e.g., agent-runner crashed)
- **THEN** an error is raised including available stderr/stdout for diagnostics

#### Scenario: Interleaved noise in stdout
- **WHEN** container stdout contains debug logs, MCP server output, or other text alongside sentinel-wrapped output
- **THEN** only the content between sentinel markers is extracted; surrounding content is ignored

### Requirement: Persist and resume agent sessions
The system SHALL persist agent sessions to the host filesystem, keyed by a stable identity derived from task name, image, and volume configuration. Executions with the same identity SHALL reuse the same session directory, enabling Claude session resumption across separate executions.

#### Scenario: Session directory created on first execution
- **WHEN** a task runs for the first time with a given configuration
- **THEN** a session directory is created on the host and mounted into the container

#### Scenario: Session reused on repeated execution
- **WHEN** a task runs again with the same name, image, and volumes
- **THEN** the same session directory is mounted, enabling the agent to resume prior session state

#### Scenario: Different config produces different session
- **WHEN** a task runs with different volumes or image from a prior execution
- **THEN** a separate session directory is used

### Requirement: Mount volumes into containers
The system SHALL mount host directories into containers as bind mounts. Volumes SHALL support both read-write and read-only modes.

#### Scenario: Read-write volume mount
- **WHEN** a consumer specifies a volume as a host-to-container path mapping
- **THEN** the directory is mounted read-write inside the container

#### Scenario: Read-only volume mount
- **WHEN** a consumer specifies a volume with readonly flag
- **THEN** the directory is mounted read-only inside the container

### Requirement: Shadow host .env files in volume mounts
The system SHALL prevent containers from reading `.env` files that exist in mounted host directories. Any `.env` files found in volume-mounted paths SHALL be shadowed (masked) so they are inaccessible inside the container.

#### Scenario: .env file exists in mounted directory
- **WHEN** a host directory containing a `.env` file is mounted into the container
- **THEN** the `.env` file is not readable inside the container

#### Scenario: Nested .env files are shadowed
- **WHEN** a host directory tree contains `.env` files at multiple levels
- **THEN** all `.env` files in the tree are shadowed

### Requirement: Inject credentials into containers
The system SHALL support multiple credential injection modes for authenticating the agent inside the container.

#### Scenario: Direct environment variable mode
- **WHEN** credential mode is "env"
- **THEN** the consumer-provided API key environment variables are passed directly to the container

#### Scenario: OneCLI proxy mode
- **WHEN** credential mode is "onecli" with a proxy URL
- **THEN** the container is configured to authenticate via the OneCLI HTTPS proxy (no API key in container)

#### Scenario: Native credential proxy mode
- **WHEN** credential mode is "proxy"
- **THEN** the container is configured to authenticate via a host-side credential proxy

#### Scenario: Missing credentials warning
- **WHEN** credential mode is "env" but no API key or OAuth token is provided
- **THEN** a warning is emitted (execution will likely fail inside the container)

### Requirement: Enable container-to-host networking
The system SHALL configure containers so they can reach host-side services (e.g., MCP gateway) via `host.docker.internal`. This SHALL work across platforms (Docker Desktop and Linux).

#### Scenario: Container reaches host service
- **WHEN** a container references `host.docker.internal`
- **THEN** it resolves to the host machine, enabling access to host-bound services

#### Scenario: Custom Docker network
- **WHEN** a consumer specifies a Docker network
- **THEN** the container is attached to that network in addition to having host access

### Requirement: Auto-build container image
The system SHALL automatically build the base Docker image on first use. If the Dockerfile content changes (detected via content hash), the image SHALL be rebuilt. Concurrent build requests SHALL be deduplicated.

#### Scenario: Image built on first execution
- **WHEN** the base image does not exist locally
- **THEN** the system builds it from the bundled Dockerfile before proceeding

#### Scenario: Image rebuilt on Dockerfile change
- **WHEN** the Dockerfile content has changed since the last build
- **THEN** the image is rebuilt with the new Dockerfile

#### Scenario: Image reused when unchanged
- **WHEN** the Dockerfile content matches the existing image
- **THEN** no rebuild occurs

#### Scenario: Concurrent builds deduplicated
- **WHEN** multiple executions trigger a build simultaneously
- **THEN** only one build runs; others wait for its completion

#### Scenario: Custom Dockerfile override
- **WHEN** a consumer provides a custom Dockerfile path
- **THEN** that Dockerfile is used instead of the bundled default

### Requirement: Clean up containers after execution
The system SHALL remove containers after execution completes (success or failure) when cleanup is enabled. Cleanup failures SHALL NOT propagate as execution errors.

#### Scenario: Container removed after successful execution
- **WHEN** an execution completes successfully with cleanup enabled
- **THEN** the container is removed

#### Scenario: Container removed after failed execution
- **WHEN** an execution fails with cleanup enabled
- **THEN** the container is still removed

#### Scenario: Cleanup failure is non-fatal
- **WHEN** container removal fails (e.g., already removed)
- **THEN** no error is raised; the execution result is still returned

#### Scenario: Orphaned container cleanup
- **WHEN** the runner is asked to clean up
- **THEN** all containers with the agentforge naming prefix are stopped and removed
