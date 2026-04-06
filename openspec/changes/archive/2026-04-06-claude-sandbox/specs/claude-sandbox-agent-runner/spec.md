## ADDED Requirements

### Requirement: Accept task input via stdin
The agent runner SHALL read a JSON-encoded task input from stdin containing: task name, prompt (string or message blocks), model, max turns, allowed/disallowed tools, output format schema, MCP server configurations, session ID for resumption, and additional environment variables.

#### Scenario: Valid JSON input
- **WHEN** valid JSON task input is written to the runner's stdin
- **THEN** the runner parses it and proceeds with execution

#### Scenario: Invalid JSON input
- **WHEN** invalid or missing JSON is provided on stdin
- **THEN** the runner emits an error output via sentinels and exits with non-zero code

### Requirement: Execute Claude Agent SDK queries
The agent runner SHALL invoke the Claude Agent SDK programmatically with the provided task configuration. It SHALL run in a permissive mode suitable for automated execution (no interactive permission prompts).

#### Scenario: Successful SDK execution
- **WHEN** the SDK completes the query successfully
- **THEN** the runner extracts structured output, session ID, and metrics from the result

#### Scenario: SDK execution failure
- **WHEN** the SDK throws an error during execution
- **THEN** the runner emits an error output via sentinels with the error message and exits with non-zero code

#### Scenario: Structured output format honored
- **WHEN** the input specifies an output format schema
- **THEN** the SDK is configured to produce output conforming to that schema

#### Scenario: Session resumption
- **WHEN** the input includes a session ID
- **THEN** the SDK resumes the existing session rather than starting a new one

#### Scenario: New session ID generated
- **WHEN** the input does not include a session ID
- **THEN** a new unique session ID is generated for the execution

### Requirement: Emit output via sentinel protocol
The agent runner SHALL emit its result (success or error) wrapped in sentinel markers on stdout. The output SHALL always be emitted — even on errors — so the host can reliably extract results.

#### Scenario: Success output emitted
- **WHEN** execution completes successfully
- **THEN** a JSON object with status "success", structured output, session ID, and metrics is emitted between sentinel markers

#### Scenario: Error output emitted
- **WHEN** execution fails
- **THEN** a JSON object with status "error" and error message is emitted between sentinel markers

#### Scenario: Sentinel output always present
- **WHEN** any catchable error occurs during execution
- **THEN** sentinel-wrapped output is emitted before the process exits (the only case without sentinels is an unrecoverable crash like OOM)

### Requirement: Collect execution metrics
The agent runner SHALL collect and report metrics from the SDK execution including: token usage (input, output, cache tokens), total cost, wall-clock duration, API-only duration, and number of conversation turns.

#### Scenario: Metrics included in success output
- **WHEN** execution completes successfully
- **THEN** the output includes usage metrics extracted from the SDK result

#### Scenario: Partial metrics on error
- **WHEN** execution fails partway through
- **THEN** metrics may be absent or incomplete in the error output

### Requirement: Propagate LangSmith trace context
The agent runner SHALL reconstruct a parent LangSmith trace from environment variables when present, linking the container execution to the host-side trace tree for end-to-end observability.

#### Scenario: Parent trace context available
- **WHEN** LangSmith parent trace environment variables are set
- **THEN** the execution is linked as a child of the parent trace

#### Scenario: No parent trace context
- **WHEN** LangSmith parent trace environment variables are absent
- **THEN** execution proceeds without parent trace linkage (standalone tracing may still occur via SDK auto-detection)

#### Scenario: Trace reconstruction failure
- **WHEN** parent trace environment variables are malformed
- **THEN** execution proceeds without parent trace linkage (failure is non-fatal)

### Requirement: Base container image provides required runtime
The base Docker image SHALL provide a runtime environment suitable for executing the agent runner and Claude Agent SDK, including: a JavaScript/TypeScript runtime, the Agent SDK, a non-root user, and the expected directory structure for workspace and settings.

#### Scenario: Non-root execution
- **WHEN** the agent runner executes inside the container
- **THEN** it runs as a non-root user

#### Scenario: Workspace directory available
- **WHEN** the container starts
- **THEN** a workspace directory exists for consumer volume mounts and a task working directory exists as the agent's cwd

#### Scenario: Settings hierarchy directories exist
- **WHEN** the container starts
- **THEN** directories for user-level settings (session persistence) and project-level settings (archetype capabilities) exist at expected paths

#### Scenario: Browser tooling available
- **WHEN** the agent needs browser-based tools
- **THEN** a headless browser is available in the container image
