# AgentForge Solution Space

## Overview

**AgentForge** is a foundational library for building production-grade agentic workflows. It provides the orchestration, sandboxing, and tool-access layers that connect workflow engines to AI agent runtimes, enabling autonomous multi-step pipelines that execute reliably without human intervention.

The library exists because building agentic workflows from scratch — wiring up container isolation, structured I/O, credential management, distributed tracing, retry policies, and tool access — is the same work every time. AgentForge codifies these patterns once, tested and hardened, so consumer applications focus entirely on business logic: what agents do, not how they're orchestrated.

## Background

Modern AI agents (Claude, GPT, etc.) excel at autonomous task execution within well-scoped boundaries — researching topics, analyzing data, generating structured outputs. But composing many agent tasks into reliable pipelines introduces orchestration challenges that the agent runtimes themselves don't solve:

- **Isolation**: Each agent task needs a clean, scoped environment. Shared state between tasks causes interference. Credential leakage is a security risk.
- **Durability**: Multi-step pipelines spanning hours must survive failures gracefully. Partial completion must be recoverable without re-executing successful work.
- **Observability**: When a pipeline processes dozens or hundreds of items through multiple phases, operators need visibility into what completed, what failed, and why.
- **Concurrency**: Fan-out over many items must be throttled to respect rate limits and resource constraints without custom plumbing in every consumer.
- **Tool access**: Agents need controlled access to external tools (search APIs, databases, domain-specific services) via standardized protocols, scoped per task.

These are infrastructure concerns, not business logic. They should be solved once in a shared foundation, not re-implemented in every application.

## Solution Spaces

### Workflow Orchestration

**Purpose:** Provide durable, observable orchestration for multi-step agentic pipelines using established workflow engines.

**Goals:**
- Express pipelines as standard code (sequential steps, parallel fan-out, conditional routing, error handling)
- Automatic durability: completed steps survive failures and aren't re-executed on retry
- Framework-managed concurrency control (no custom throttling per consumer)
- Observable execution: progress tracking, state inspection, and searchable execution history
- Type-safe pipeline definitions with compile-time validation
- Support for hierarchical pipelines (parent dispatching child workflows per item)

**Success Metrics:**
- Consumer pipelines are readable top-to-bottom as procedures
- Partial failure recovery works without consumer-side retry logic
- Adding a new pipeline step is adding a function call, not updating schemas or graph topology
- Operators can inspect pipeline progress via standard tooling

### Agent Sandbox

**Purpose:** Execute AI agent tasks in isolated, reproducible environments with controlled I/O, credential injection, and session management.

**Goals:**
- Full environment isolation per task (filesystem, network, credentials)
- Structured input/output contract (typed prompts in, validated structured output out)
- Reliable output extraction from mixed agent output streams
- Session persistence for task resumption across failures
- Credential injection without exposing secrets inside agent environments
- Settings hierarchy via Claude Code's native `.claude/` directory traversal
- Distributed tracing propagation across process boundaries

**Success Metrics:**
- Agent tasks cannot interfere with each other or access unauthorized resources
- Structured output is reliably extracted and validated regardless of agent noise
- Failed tasks can be retried with session state intact
- Consumers configure sandbox behavior declaratively, not procedurally

### Tool Gateway

**Purpose:** Provide centralized, profile-scoped access to external tools for sandboxed agents via standard protocols.

**Goals:**
- Bridge tool servers to HTTP transport for cross-container access
- Profile-based tool filtering (different tasks see different tool subsets)
- Centralized tool server lifecycle management (single instance, many consumers)
- Tool call logging for observability and debugging
- Minimal overhead — thin bridge, not a middleware framework

**Success Metrics:**
- Agents access only the tools their profile permits
- Adding a new tool server is configuration, not code
- Tool gateway handles multiple concurrent consumers without per-consumer overhead
- Tool access works identically in local development and production

## Design Philosophy

### Thin Layer, Not Framework

AgentForge is a library of composable packages, not a framework. Each package solves one concern (orchestration, sandboxing, tool access) with a narrow, well-defined API. Consumers compose packages as needed — they are not required to adopt the full stack.

### Purpose-Built Packages

Packages are named for what they actually wrap, not abstract categories. `temporal-workflow` not `agent-workflow`. `claude-sandbox` not `agent-sandbox`. When new workflow engines or agent runtimes are supported, they get new packages — not generic abstractions that paper over fundamental differences.

### Consumer Owns Domain Logic

AgentForge has no awareness of consumer domain concepts (trends, trading signals, reports). It provides orchestration primitives (`activity factory`, `retry presets`), sandbox execution (`container runner`, `sentinel I/O`), and tool access (`gateway`, `profiles`). Consumers define their prompts, schemas, pipelines, and domain types.

### Tested Foundation, Lightweight Consumers

The library is rigorously tested so consumers can trust it. Unit tests for lifecycle, retry, state mapping, error classification. Integration tests for container execution, volume mounting, I/O protocol, trace propagation. Consumers skip pedantic infrastructure testing and focus on business-value integration tests.

### Production-Grade, Not Enterprise-Grade

Built for small teams running real workloads. Reliable, observable, recoverable. Not built for multi-tenant SaaS, zero-downtime rolling upgrades, or regulatory compliance frameworks. The target is a solo engineer or small team running autonomous pipelines for specific clients.

## Scope

### In Scope

- Workflow orchestration integration (durable pipelines, fan-out, retry, observability)
- Container-based agent isolation (Docker sandbox lifecycle, volume management, credential injection)
- Structured agent I/O (typed input contracts, validated structured output, sentinel protocol)
- Tool gateway (HTTP bridge for tool protocol servers, profile-scoped filtering)
- Distributed tracing propagation (cross-process trace hierarchy)
- Session management (persistence, resumption across failures)
- Configuration patterns (settings hierarchy, config merge utilities)

### Out of Scope

- Agent prompt engineering (consumers own all prompts and directives)
- Domain-specific schemas (consumers define their own types and validation)
- Model provider abstraction (packages are model-specific: `claude-sandbox`, not `llm-sandbox`)
- UI/dashboard (leverage existing tooling: workflow engine UIs, tracing platforms)
- Deployment automation (consumers manage their own infrastructure)
- Multi-tenant isolation (single-operator assumption)

### Future Scope

- Additional workflow engine integrations (as needs arise)
- Additional agent runtime integrations (as models/SDKs evolve)
- Worker deployment patterns (container orchestration, auto-scaling)
- Advanced credential management (rotation, multi-provider, audit logging)

## Assumptions

- Consumers use TypeScript/JavaScript runtimes (Bun or Node.js)
- Docker is available in all execution environments (local dev and production)
- A single workflow engine instance serves all consumer pipelines (shared infrastructure)
- Consumer applications are single-operator (no multi-tenant requirements)
- Agent runtimes handle their own model API rate limiting
- External tool APIs handle their own rate limiting
