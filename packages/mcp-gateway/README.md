# @beruangai/agentforge-mcp-gateway

HTTP reverse proxy that unifies multiple MCP servers behind a single endpoint with per-request tool filtering and rate limiting.

## Usage

```typescript
import { createGateway, mcpConfigForGateway } from '@beruangai/agentforge-mcp-gateway';

// Start gateway with upstream MCP servers
const gateway = await createGateway({
  port: 8080,
  servers: {
    filesystem: {
      transport: 'stdio',
      command: 'bun',
      args: ['run', '/path/to/fs-server.ts'],
    },
    'search-api': {
      transport: 'streamable-http',
      url: 'https://mcp.search-provider.com/mcp',
      headers: { Authorization: `Bearer ${process.env.SEARCH_API_KEY}` },
      rateLimit: { rpm: 60 },
    },
  },
});

// Generate MCP config for agent containers
const mcpConfig = mcpConfigForGateway({
  gatewayHost: 'host.docker.internal',
  gatewayPort: 8080,
  tools: ['filesystem:*', 'search-api:search'],
});

// Shutdown
await gateway.close();
```

## Tool Filtering

Clients declare which tools they need via the `X-Tools` header. Supports glob patterns:

- `vault:read` — exact match
- `vault:*` — all tools from the vault server
- `*` — all tools (default when header is absent)

## Rate Limiting

Configure per-server or per-tool rate limits. Requests at capacity are queued (FIFO) and resolved when slots open:

```typescript
servers: {
  api: {
    transport: 'streamable-http',
    url: 'https://api.example.com/mcp',
    rateLimit: {
      rpm: 60,
      tools: { expensive: { rpm: 10 } },
    },
  },
}
```

## Building

```bash
bunx nx build @beruangai/agentforge-mcp-gateway
```

## Testing

```bash
bunx nx test @beruangai/agentforge-mcp-gateway
```
