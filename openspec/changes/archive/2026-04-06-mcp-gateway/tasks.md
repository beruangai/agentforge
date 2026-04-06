# Tasks: MCP Gateway Package

## Phase 1: Tool Filtering

- [x] Implement `filterTools()` — glob-based tool filtering (minimatch)
- [x] Implement `parseToolFilter()` — parse `X-Tools` header
- [x] Implement `isToolAllowed()` — check single tool against filter patterns
- [x] Support wildcard patterns (`vault:*`), exact match (`serpapi:search`), no filter = all
- [x] Write unit tests for tool filtering (match, no-match, wildcards, multiple patterns, edge cases)
- [x] Write unit tests for header parsing

## Phase 2: Upstream Connections

- [x] Implement `StdioConnection` — start/stop stdio MCP server process, call tools
- [x] Implement `StreamableHttpConnection` — Streamable HTTP MCP client passthrough
- [x] Implement `UpstreamManager` — manage multiple upstreams, tool discovery, tool name prefixing
- [x] Add auto-restart on crash for stdio connections
- [x] Write unit tests with mock MCP server fixture
- [x] Write integration test for upstream lifecycle (start, discover tools, call, stop, restart)

## Phase 3: Rate Limiting

- [x] Implement `TokenBucket` — token bucket with FIFO queue (acquire blocks when at capacity)
- [x] Implement `RateLimiter` — manages per-server and per-tool token buckets
- [x] Support RPM and RPS configuration
- [x] Support per-tool overrides within a server
- [x] Handle client connection close → remove queued request, free slot
- [x] Write unit tests for token bucket (fill, drain, queue, refill, FIFO order)
- [x] Write unit tests for rate limiter (server-level, tool-level, combined)
- [x] Write integration test: concurrent requests queued at capacity, resolved in order

## Phase 4: HTTP Gateway Server

- [x] Choose HTTP framework (Hono or Fastify — lean, minimal)
- [x] Implement gateway server with single `/mcp` endpoint
- [x] Implement `tools/list` handler (aggregate + filter per request)
- [x] Implement `tools/call` handler (filter gate, rate limit, route to upstream, log)
- [x] Implement tool name prefixing/stripping (`vault:read` → upstream `read`)
- [x] Implement request logging (tool name, upstream, duration, queued time)
- [x] Implement `createGateway()` factory (start server + connect upstreams + init rate limiter)
- [x] Implement `gateway.close()` graceful shutdown (complete in-flight, drain queue)
- [x] Write integration tests (full request flow, filter enforcement, rate limiting, concurrent requests)

## Phase 5: Container Integration

- [x] Implement `mcpConfigForGateway()` helper (generate mcpServers config with tool filter)
- [x] Write unit tests for config generation
- [x] ~~Integration test with claude-sandbox~~ — deferred to `temporal-workflow` package (cross-package dependency)

## Phase 6: Polish & Publish

- [x] Create mock MCP server test fixtures (stdio + Streamable HTTP)
- [x] Export all public API from `index.ts`
- [x] Add JSDoc comments to public API
- [x] Verify build output (ESM, `.d.ts`)
- [x] Write package README with usage examples
