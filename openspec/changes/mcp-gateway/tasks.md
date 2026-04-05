# Tasks: MCP Gateway Package

## Phase 1: Tool Filtering

- [ ] Implement `filterTools()` — glob-based tool filtering (minimatch)
- [ ] Implement `parseToolFilter()` — parse `X-Tools` header
- [ ] Implement `isToolAllowed()` — check single tool against filter patterns
- [ ] Support wildcard patterns (`vault:*`), exact match (`serpapi:search`), no filter = all
- [ ] Write unit tests for tool filtering (match, no-match, wildcards, multiple patterns, edge cases)
- [ ] Write unit tests for header parsing

## Phase 2: Upstream Connections

- [ ] Implement `StdioConnection` — start/stop stdio MCP server process, call tools
- [ ] Implement `StreamableHttpConnection` — Streamable HTTP MCP client passthrough
- [ ] Implement `UpstreamManager` — manage multiple upstreams, tool discovery, tool name prefixing
- [ ] Add auto-restart on crash for stdio connections
- [ ] Write unit tests with mock MCP server fixture
- [ ] Write integration test for upstream lifecycle (start, discover tools, call, stop, restart)

## Phase 3: Rate Limiting

- [ ] Implement `TokenBucket` — token bucket with FIFO queue (acquire blocks when at capacity)
- [ ] Implement `RateLimiter` — manages per-server and per-tool token buckets
- [ ] Support RPM and RPS configuration
- [ ] Support per-tool overrides within a server
- [ ] Handle client connection close → remove queued request, free slot
- [ ] Write unit tests for token bucket (fill, drain, queue, refill, FIFO order)
- [ ] Write unit tests for rate limiter (server-level, tool-level, combined)
- [ ] Write integration test: concurrent requests queued at capacity, resolved in order

## Phase 4: HTTP Gateway Server

- [ ] Choose HTTP framework (Hono or Fastify — lean, minimal)
- [ ] Implement gateway server with single `/mcp` endpoint
- [ ] Implement `tools/list` handler (aggregate + filter per request)
- [ ] Implement `tools/call` handler (filter gate, rate limit, route to upstream, log)
- [ ] Implement tool name prefixing/stripping (`vault:read` → upstream `read`)
- [ ] Implement request logging (tool name, upstream, duration, queued time)
- [ ] Implement `createGateway()` factory (start server + connect upstreams + init rate limiter)
- [ ] Implement `gateway.close()` graceful shutdown (complete in-flight, drain queue)
- [ ] Write integration tests (full request flow, filter enforcement, rate limiting, concurrent requests)

## Phase 5: Container Integration

- [ ] Implement `mcpConfigForGateway()` helper (generate mcpServers config with tool filter)
- [ ] Write unit tests for config generation
- [ ] Integration test with claude-sandbox: container → gateway → mock upstream

## Phase 6: Polish & Publish

- [ ] Create mock MCP server test fixtures (stdio + Streamable HTTP)
- [ ] Export all public API from `index.ts`
- [ ] Add JSDoc comments to public API
- [ ] Verify build output (ESM, `.d.ts`)
- [ ] Write package README with usage examples
