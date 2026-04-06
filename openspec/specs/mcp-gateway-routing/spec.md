## ADDED Requirements

### Requirement: Proxy MCP requests through a single HTTP endpoint
The gateway SHALL expose a single HTTP endpoint that accepts MCP protocol requests and routes them to the appropriate upstream MCP server. Clients connect to one gateway URL regardless of how many upstream servers exist.

#### Scenario: tools/list aggregates from all upstreams
- **WHEN** a client sends a `tools/list` request to the gateway
- **THEN** the gateway returns tools from all connected upstream servers, each prefixed with the upstream server name (`<server>:<tool>`)

#### Scenario: tools/call routes to correct upstream
- **WHEN** a client sends a `tools/call` request for a prefixed tool (e.g., `vault:read`)
- **THEN** the gateway strips the prefix, routes the call to the correct upstream server, and returns the result

#### Scenario: Unknown tool prefix returns error
- **WHEN** a client sends a `tools/call` request with a prefix that doesn't match any upstream
- **THEN** the gateway returns a 500 error indicating unknown server

#### Scenario: Unknown MCP method
- **WHEN** a client sends a request with an unrecognized MCP method
- **THEN** the gateway returns a 400 error

### Requirement: Filter tools per request via client header
The gateway SHALL filter which tools are visible and callable per request based on the `X-Tools` header. This controls tool visibility (not just permission) — agents only see tools matching their filter.

#### Scenario: Client requests specific tools via X-Tools header
- **WHEN** a client includes `X-Tools: vault:read,vault:list,serpapi:search` in the request
- **THEN** the `tools/list` response returns only those tools

#### Scenario: Glob patterns in tool filter
- **WHEN** a client includes `X-Tools: vault:*,serpapi:*` in the request
- **THEN** all tools from matching servers are included in the response

#### Scenario: tools/call rejected for filtered-out tool
- **WHEN** a client calls a tool that is not in their `X-Tools` filter
- **THEN** the gateway returns a 403 error

#### Scenario: No X-Tools header allows all tools
- **WHEN** a client sends a request without an `X-Tools` header
- **THEN** all tools from all upstreams are available (fully trusted environment)

### Requirement: Manage upstream MCP server connections
The gateway SHALL connect to upstream MCP servers at startup, supporting both local stdio processes and remote Streamable HTTP endpoints. Tool discovery happens on connection.

#### Scenario: Local stdio server started and connected
- **WHEN** the gateway starts with a stdio upstream configured
- **THEN** the gateway spawns the process, connects via MCP stdio transport, and discovers its tools

#### Scenario: Remote Streamable HTTP server connected
- **WHEN** the gateway starts with a Streamable HTTP upstream configured
- **THEN** the gateway connects via Streamable HTTP transport and discovers its tools

#### Scenario: Stdio server crash with auto-restart
- **WHEN** a stdio upstream process crashes and `autoRestart` is enabled (default)
- **THEN** the gateway restarts the process and reconnects

#### Scenario: Upstream server unreachable
- **WHEN** an upstream server is not reachable during a tool call
- **THEN** the gateway returns a 503 error for that tool call

### Requirement: Rate limit tool calls across all agents
The gateway SHALL enforce rate limits on tool calls at the server level and optionally at the tool level. When at capacity, requests SHALL be queued (FIFO) and resolved when slots become available — never rejected with an error.

#### Scenario: Request within rate limit
- **WHEN** a tool call arrives and the server/tool is under its rate limit
- **THEN** the request is forwarded immediately

#### Scenario: Request at capacity queued FIFO
- **WHEN** a tool call arrives and the server/tool is at capacity
- **THEN** the request is queued and resolved when a slot becomes available (FIFO order)

#### Scenario: Per-tool rate limit override
- **WHEN** a server has a per-tool rate limit configured for a specific tool
- **THEN** that tool is limited independently from the server-level limit

#### Scenario: Client timeout releases queued slot
- **WHEN** a queued request's client connection closes (client timeout)
- **THEN** the request is removed from the queue and the slot is freed

### Requirement: Generate container MCP configuration
The gateway SHALL provide a helper to generate MCP server configuration for agent containers, including the gateway URL and tool filter header.

#### Scenario: Config generated with tool filter
- **WHEN** a consumer calls the config helper with gateway host, port, and tool patterns
- **THEN** a valid MCP server config object is returned with the gateway URL and `X-Tools` header

#### Scenario: Config works with sandbox execution
- **WHEN** the generated config is passed to a sandbox execution as `mcpServers`
- **THEN** the agent inside the container connects to the gateway and sees only the filtered tools

#### Scenario: Gateway instance generates config from tool filters
- **WHEN** `gateway.mcpServersConfig(tools)` is called with tool filter patterns
- **THEN** a valid MCP server config record is returned using the gateway's port and configured container host

### Requirement: Graceful startup and shutdown
The gateway SHALL connect to all upstream servers before accepting requests, and SHALL complete in-flight requests before shutting down.

#### Scenario: Gateway startup connects all upstreams
- **WHEN** `createGateway()` is called
- **THEN** all upstream servers are connected and tools discovered before the function resolves

#### Scenario: Graceful shutdown completes in-flight requests
- **WHEN** `gateway.close()` is called while requests are in-flight
- **THEN** in-flight requests complete, queued requests are drained, then the server stops

#### Scenario: Gateway status reports upstream health
- **WHEN** `gateway.status()` is called
- **THEN** the current status (running/stopped/error), transport type, and tool count for each upstream is returned
