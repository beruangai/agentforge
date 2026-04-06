# Proposal: Claude Sandbox Package

## Summary

Implement `@beruangai/agentforge-claude-sandbox` — Docker container lifecycle management for executing Claude Agent SDK tasks in isolated environments. The package handles container creation, volume mounting, credential injection, sentinel I/O protocol, session management, and structured output extraction.

## Problem

Running Claude Agent SDK tasks in Docker containers requires solving several infrastructure challenges:

- **Container lifecycle**: Creating, starting, monitoring, and cleaning up containers with correct configuration
- **Structured I/O**: Reliably extracting typed JSON output from agent processes that produce mixed stdout (debug logs, MCP server output, SDK progress)
- **Session management**: Persisting and resuming agent sessions across failures via `.claude/` directory mounts
- **Credential injection**: Passing API keys securely, with a path to zero-secret containers via proxy injection
- **Volume management**: Configuring per-task filesystem mounts (workspace data, context, settings hierarchies)
- **Settings hierarchy**: Docker `.claude/` directory mounts leverage Claude Code's native settings traversal (no custom merge logic)

These are identical across every consumer running agent tasks in containers. The sentinel I/O protocol, container identity scheme, and session persistence pattern are particularly non-obvious to implement correctly.

## Proposed Solution

A package with two components:

### Host-Side: `SandboxRunner`

1. **`SandboxRunner` class** — Main API for container execution:
   - `execute(config)` → creates container, runs agent-runner, extracts output, returns structured result
   - Configurable image, timeout, network, cleanup behavior
   - Volume resolution (static paths and dynamic functions)
   - Host networking (auto-injects `host.docker.internal` for cross-platform container-to-host access)
   - Environment variable injection (credentials, trace context, custom env)

2. **Container identity** — Config-hash-based container naming:
   - Deterministic name from hash of volumes + image config
   - Enables session resumption: same config hash = same `.claude/` mount
   - `agentforge-<name>-<hash>` naming convention

3. **Sentinel I/O protocol** — Reliable output extraction:
   - Parse stdout for `---AGENTFORGE_OUTPUT_START---` / `---AGENTFORGE_OUTPUT_END---` markers
   - Extract and parse JSON between sentinels
   - Robust against interleaved MCP server output, SDK debug logs, etc.

4. **Credential modes**:
   - `env` mode: Pass `ANTHROPIC_API_KEY` directly as container env var (phase 1)
   - `onecli` mode: Configure OneCLI HTTPS proxy for zero-secret containers (phase 2)

### Container-Side: Agent Runner

Bundled into the base Docker image. Runs inside the container as the entrypoint:

1. **Agent runner process** (`agent-runner/`):
   - Reads `AgentForgeContainerInput` from stdin (JSON)
   - Configures and calls Agent SDK `query()` programmatically
   - Wraps SDK with `wrapClaudeAgentSDK` for automatic LLM tracing
   - Reconstructs LangSmith parent trace context from env vars
   - Emits `AgentForgeContainerOutput` via sentinel-wrapped stdout
   - Handles graceful shutdown and error reporting

2. **Base Dockerfile**:
   - Bun runtime + Agent SDK
   - Non-root user (`agent`)
   - Clean `.claude/` scope
   - Agent-runner as entrypoint

## Non-Goals

- **Orchestration**: The sandbox has no awareness of workflows, pipelines, or scheduling. It executes single tasks.
- **Prompt building**: Consumers pass fully-formed prompts. The sandbox doesn't construct or transform prompts.
- **Output schema definitions**: Consumers provide Zod schemas. The sandbox validates but doesn't define schemas.
- **Live multi-turn sessions**: No IPC polling or live follow-up message support. Multi-turn is supported only via session resumption — sessions are persisted to host and re-mounted for the same container config hash, enabling Claude `resume` across separate executions. But the sandbox does not keep a live session open between turns.
- **Container orchestration**: No Kubernetes, Docker Compose, or Swarm integration. Single-container execution.

## Consumer Impact

Consumers call `runner.execute()` from Temporal activities (or any orchestrator) with task-specific volumes, prompts, and structured output schemas. The sandbox handles all container mechanics. Different consumers use different volumes, prompts, and schemas — the execution model is identical.

## Reference Architecture

Pattern adopted from [nanoclaw](https://github.com/qwibitai/nanoclaw) (battle-tested Claude Agent SDK container isolation). Key patterns: sentinel I/O, per-task session persistence, `.env` shadowing, settings sources, non-root user. Adapted for execute-to-completion model (vs nanoclaw's multi-turn conversational model).

## Dependencies

| Package | Purpose |
|---------|---------|
| `dockerode` | Docker API client for container management |
| `@anthropic-ai/claude-code` | Agent SDK (used by agent-runner inside container) |
| `langsmith` | LangSmith tracing (wrapClaudeAgentSDK, RunTree) |
| `zod` | Output validation |

## Execution Profile

AgentForge targets **long-running, autonomous, multi-agent pipelines** — deep research tasks, complex analysis, multi-step data processing. Tasks typically run minutes to tens of minutes. This is not a real-time chat platform and has no latency-sensitive end-user interaction.

This execution profile means:
- Container startup latency (~2-5s) is negligible relative to task duration
- Optimization priority is **security, determinism, and data quality** over latency
- Session persistence and resumption matter more than session responsiveness

## Risks

- **Docker availability**: All execution environments must have Docker. No fallback for containerless execution (dev mode with `sandbox: false` is consumer-side).
- **Agent SDK breaking changes**: The agent-runner is tightly coupled to `@anthropic-ai/claude-code` API. Pin SDK version in base image.
- **Sentinel collision**: Extremely unlikely but possible if agent output contains sentinel strings. Use unique, long sentinels.
