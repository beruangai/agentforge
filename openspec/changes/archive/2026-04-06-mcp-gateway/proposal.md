# Proposal: MCP Gateway Package

## Summary

Implement `@beruangai/agentforge-mcp-gateway` — an HTTP reverse proxy that unifies access to multiple MCP servers (local stdio, remote Streamable HTTP) behind a single endpoint with per-request tool filtering. Sandboxed agent containers connect to one gateway URL and declare which tools they need; the gateway proxies only those tools and hides everything else.

## Problem

Agent tasks running in Docker containers need access to external tools (web search, data APIs, domain-specific services) via MCP servers. Without a gateway:

1. **N×M server overhead**: Each container must configure and potentially start its own MCP server processes. For N containers × M tool servers, this is wasteful.
2. **Context bloat**: Claude Agent SDK's `allowedTools` controls *permission* but not *visibility* — MCP tools require explicit permission before Claude can use them, but without permission Claude still sees all available tools in its context window. This bloats context with irrelevant tools across every agent task.
3. **Configuration sprawl**: Each container needs full MCP server configs (commands, args, env vars, API keys) for every tool server it might use.

The gateway centralizes server management and provides server-side tool filtering so agents only see the minimal tool set they need.

## Proposed Solution

A minimal MCP reverse proxy with per-request tool filtering:

1. **HTTP reverse proxy** — Single endpoint proxying to multiple upstream MCP servers:
   - Upstream servers can be **any MCP transport**: local stdio processes or remote Streamable HTTP endpoints
   - One gateway instance per consumer application
   - Containers connect via a single gateway URL

2. **Per-request tool filtering** — Clients declare which tools they need:
   - Client passes a tool list via `X-Tools` request header (e.g., `X-Tools: vault:read,vault:list,serpapi:search`)
   - Header-only (not query params) to avoid conflicts with MCP protocol params and URL length limits
   - Gateway's `tools/list` response returns only the requested tools
   - Gateway rejects `tools/call` for tools not in the client's list
   - No static profile system — filtering is fully dynamic per request, configured in client code (e.g., agent SDK `mcpServers` config)
   - This is a single-application, fully-trusted environment — no admin UI, no profile management

3. **Upstream server management** — Lifecycle for local servers, passthrough for remote:
   - Local stdio servers: start/stop, health monitoring, auto-restart on crash
   - Remote Streamable HTTP servers: passthrough proxy with health checks
   - All upstream servers registered at gateway startup via config

4. **Container integration helpers**:
   - Generate MCP server config for agent containers (`mcpServers` JSON with tool filter header)

5. **Unified rate limiting** — Centralized across all agents:
   - Per-server and/or per-tool rate limits (RPM/RPS) configured at gateway startup
   - When at capacity: **queue and FIFO resolve** when slots become available (not error)
   - Client agent controls its own timeout threshold — if a queued request exceeds the agent's timeout, the agent cancels it
   - Replaces consumer-side rate limiting (e.g., PreToolUse hooks with shared bucket DBs) — consumers should never think about rate limits
   - Configuration: `rateLimit: { rpm: 60 }` per server or `rateLimit: { rpm: 10 }` per tool

## Non-Goals

- **Request mutation**: No per-tool middleware for modifying request parameters.
- **Admin UI or profile management**: Single-application, single-operator. Config is code.
- **Authentication between containers and gateway**: Runs on internal Docker network. Fully trusted.
- **Multi-tenant access control**: Single consumer per gateway instance.

## Consumer Impact

Consumers create a single gateway with their upstream tool servers (local stdio, remote Streamable HTTP). Each agent task's sandbox config includes the gateway URL with its specific tool filter. For example, research tasks see `search:*,data:*,vault:*`; analysis tasks see `vault:*` only. Tool filtering is per-request — no code changes to add/remove tool access for different task types.

## Spike Results: Existing Solutions

Evaluated existing open-source MCP gateways:

| Project | Assessment |
|---------|-----------|
| [mcp-filter](https://github.com/pro-vi/mcp-filter) | Good per-server tool filtering pattern, but single-server only — doesn't aggregate multiple servers behind one endpoint |
| [mcp-context-forge](https://github.com/IBM/mcp-context-forge) (IBM) | Rich features (admin UI, profile management) but enterprise-oriented — separate service with management overhead we don't need |
| [mcp-gateway](https://github.com/microsoft/mcp-gateway) (Microsoft) | Control-plane style gateway with admin API — solid features but built for large-scale multi-team use cases |
| [mcp-proxy](https://github.com/sparfenyuk/mcp-proxy) | Pure proxy without tool filtering support |

**Conclusion**: No existing project fits our narrow requirements (multi-server reverse proxy + dynamic per-request tool filtering without admin overhead). Build minimal custom gateway. Borrow patterns from `mcp-filter` for tool filtering implementation.

## Dependencies

| Package | Purpose |
|---------|---------|
| `@modelcontextprotocol/sdk` | MCP protocol client/server |
| `hono` or `fastify` | HTTP server (lean, minimal) |
| `minimatch` | Glob pattern matching for tool filtering |

## Risks

- **Single point of failure**: One gateway process serves all containers. Mitigation: process supervisor, health checks, auto-restart.
- **MCP protocol evolution**: MCP spec is evolving. Using `@modelcontextprotocol/sdk` helps track changes.
- **Upstream server diversity**: Different MCP servers may have transport quirks. Test with real servers early.
- **Legacy SSE servers**: Some upstream servers may still use the deprecated HTTP+SSE transport (pre-2025-03-26 spec). The Streamable HTTP client in `@modelcontextprotocol/sdk` handles backwards compatibility, but test with older servers.
