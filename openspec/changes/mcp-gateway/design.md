# Design: MCP Gateway Package

## Core Concept

A minimal MCP reverse proxy that aggregates multiple upstream MCP servers (local stdio, remote Streamable HTTP) behind a single HTTP endpoint. Clients declare which tools they need per request; the gateway filters `tools/list` and gates `tools/call` accordingly.

No static profiles, no admin UI, no management API. Configuration is code. Filtering is per-request via client headers.

## Public API

### `createGateway()`

Creates and starts the gateway server.

```typescript
import { createGateway } from '@beruangai/agentforge-mcp-gateway';

const gateway = await createGateway({
  port: 8080,
  host: '0.0.0.0',

  // Upstream MCP servers (any transport)
  servers: {
    // Local stdio server
    filesystem: {
      transport: 'stdio',
      command: 'bun',
      args: ['run', '/path/to/fs-server.ts'],
      env: { ROOT_DIR: '/data' },
    },
    // Remote Streamable HTTP server with rate limiting
    'search-api': {
      transport: 'streamable-http',
      url: 'https://mcp.search-provider.com/mcp',
      headers: { 'Authorization': `Bearer ${process.env.SEARCH_API_KEY}` },
      rateLimit: { rpm: 60 },  // server-level: 60 requests/minute
    },
    // Another remote Streamable HTTP server
    'data-api': {
      transport: 'streamable-http',
      url: 'https://mcp.data-provider.com/mcp',
      headers: { 'Authorization': `Bearer ${process.env.DATA_API_KEY}` },
      rateLimit: { rpm: 30 },
    },
  },
});

// Gateway running at http://0.0.0.0:8080
// Clients filter tools via X-Tools header

await gateway.close(); // Graceful shutdown
```

### Type Signatures

```typescript
interface GatewayConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to (default: '0.0.0.0') */
  host?: string;
  /** Upstream MCP servers */
  servers: Record<string, UpstreamServerConfig>;
  /** Enable request logging (default: true) */
  logging?: boolean;
}

type UpstreamServerConfig =
  | StdioServerConfig
  | StreamableHttpServerConfig;

interface StdioServerConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Restart on crash (default: true) */
  autoRestart?: boolean;
  /** Rate limit for this server (applied across all agents) */
  rateLimit?: RateLimitConfig;
}

interface StreamableHttpServerConfig {
  transport: 'streamable-http';
  url: string;
  headers?: Record<string, string>;
  /** Rate limit for this server (applied across all agents) */
  rateLimit?: RateLimitConfig;
}

interface RateLimitConfig {
  /** Requests per minute (server-level) */
  rpm?: number;
  /** Requests per second (server-level) */
  rps?: number;
  /** Per-tool overrides (e.g., { 'search': { rpm: 10 } }) */
  tools?: Record<string, { rpm?: number; rps?: number }>;
}

interface Gateway {
  /** Graceful shutdown */
  close(): Promise<void>;
  /** Current server status */
  status(): GatewayStatus;
}

interface GatewayStatus {
  port: number;
  upstreams: Record<string, {
    status: 'running' | 'stopped' | 'error';
    transport: string;
    toolCount: number;
  }>;
}
```

### Container Integration Helper

Generates MCP server config for agent containers with tool filtering:

```typescript
import { mcpConfigForGateway } from '@beruangai/agentforge-mcp-gateway';

// Research agent — sees search + data + filesystem tools
const researchMcp = mcpConfigForGateway({
  gatewayHost: 'host.docker.internal',
  gatewayPort: 8080,
  tools: ['filesystem:*', 'search-api:*', 'data-api:*'],
});

// Analysis agent — sees filesystem only
const analysisMcp = mcpConfigForGateway({
  gatewayHost: 'host.docker.internal',
  gatewayPort: 8080,
  tools: ['filesystem:*'],
});

// Returns MCP server config for sandbox input:
// {
//   gateway: {
//     type: 'http',
//     url: 'http://host.docker.internal:8080/mcp',
//     headers: { 'X-Tools': 'vault:*,serpapi:*,lunarcrush:*' }
//   }
// }
```

## Internal Architecture

### Request Flow

```
Agent Container (Docker)
  │
  │  HTTP request to http://gateway:8080/mcp
  │  Header: X-Tools: vault:read,vault:list,serpapi:search
  │
  ▼
Gateway Server
  │
  ├── Parse tool filter from X-Tools header
  │
  ├── tools/list request:
  │   ├── Aggregate tools from all upstreams
  │   ├── Filter to only tools matching client's list (glob match)
  │   └── Return filtered tool list
  │
  ├── tools/call request:
  │   ├── Check tool is in client's allowed list
  │   ├── Extract server prefix (e.g., "vault" from "vault:read")
  │   ├── Check rate limit (server-level and/or tool-level)
  │   │   ├── Under limit → forward immediately
  │   │   └── At capacity → enqueue (FIFO), resolve when slot available
  │   ├── Route to correct upstream server
  │   ├── Forward call, return result
  │   └── Log: tool name, upstream, duration, status, queued time
  │
  └── Unknown method: 400
```

### Tool Naming Convention

Tools are namespaced by server: `<server>:<tool>`. The gateway:
1. On startup, connects to all upstreams and discovers their tools
2. Prefixes each tool with the server name: `vault` server's `read` tool → `vault:read`
3. Client requests use these prefixed names
4. Gateway strips prefix when forwarding to upstream

### Tool Filtering (`tool-filter.ts`)

```typescript
import { minimatch } from 'minimatch';

export function filterTools(
  allTools: ToolDefinition[],
  requestedPatterns: string[],
): ToolDefinition[] {
  return allTools.filter(tool =>
    requestedPatterns.some(pattern => minimatch(tool.name, pattern))
  );
}

export function isToolAllowed(
  toolName: string,
  requestedPatterns: string[],
): boolean {
  return requestedPatterns.some(pattern => minimatch(toolName, pattern));
}

export function parseToolFilter(request: Request): string[] {
  const header = request.headers.get('X-Tools');
  if (header) return header.split(',').map(t => t.trim());

  // No header = all tools (fully trusted environment)
  return ['*'];
}
```

### Upstream Management (`upstream.ts`)

```typescript
class UpstreamManager {
  private servers: Map<string, UpstreamConnection>;

  /** Connect to all configured upstreams, discover tools */
  async connectAll(configs: Record<string, UpstreamServerConfig>): Promise<void>;

  /** Disconnect all upstreams */
  async disconnectAll(): Promise<void>;

  /** Get all tools across all upstreams (prefixed with server name) */
  getAllTools(): ToolDefinition[];

  /** Route a tool call to the correct upstream */
  async callTool(prefixedName: string, args: unknown): Promise<unknown>;
}

// Polymorphic upstream connection
type UpstreamConnection =
  | StdioConnection              // manages child process, MCP stdio client
  | StreamableHttpConnection;    // Streamable HTTP MCP client
```

### HTTP Server (`gateway.ts`)

```typescript
// Hono or Fastify — minimal server
app.all('/mcp', async (ctx) => {
  const toolFilter = parseToolFilter(ctx.req);
  const request = await ctx.req.json();

  switch (request.method) {
    case 'tools/list': {
      const allTools = upstreamManager.getAllTools();
      const filtered = filterTools(allTools, toolFilter);
      return ctx.json({ result: { tools: filtered } });
    }

    case 'tools/call': {
      const { name, arguments: args } = request.params;

      if (!isToolAllowed(name, toolFilter)) {
        return ctx.json({
          error: { code: -32600, message: `Tool '${name}' not in allowed list` }
        }, 403);
      }

      const startTime = Date.now();

      // Rate limiting: acquire slot or queue (FIFO)
      // Client controls its own timeout — if this takes too long,
      // the agent's HTTP timeout will abort the request
      await rateLimiter.acquire(name);

      const queuedMs = Date.now() - startTime;
      const result = await upstreamManager.callTool(name, args);

      if (logging) {
        logger.info({
          tool: name,
          durationMs: Date.now() - startTime,
          queuedMs,
        });
      }

      return ctx.json({ result });
    }

    default:
      return ctx.json({ error: { code: -32601, message: 'Method not found' } }, 400);
  }
});
```

### Rate Limiting (`rate-limiter.ts`)

Unified rate limiting across all agents. When a tool call arrives and the server/tool is at capacity, the request is queued (FIFO) and resolved when a slot becomes available. The gateway never errors on rate limits — it queues. The client agent controls its own HTTP timeout; if the queued wait exceeds the agent's patience, the agent aborts the request.

```typescript
class RateLimiter {
  private limiters: Map<string, TokenBucket>;  // keyed by server or server:tool

  constructor(configs: Record<string, RateLimitConfig>) {
    // Create token buckets for each configured server/tool
    for (const [server, config] of Object.entries(configs)) {
      if (config.rpm || config.rps) {
        this.limiters.set(server, new TokenBucket(config));
      }
      // Per-tool overrides
      for (const [tool, toolConfig] of Object.entries(config.tools ?? {})) {
        this.limiters.set(`${server}:${tool}`, new TokenBucket(toolConfig));
      }
    }
  }

  /**
   * Acquire a rate limit slot for the given tool.
   * If at capacity, queues the request (FIFO) and resolves when a slot opens.
   * The caller (HTTP handler) will be awaiting this promise —
   * if the client's HTTP request times out, the connection closes
   * and the queued slot is released.
   */
  async acquire(prefixedToolName: string): Promise<void> {
    const [server] = prefixedToolName.split(':', 2);

    // Check tool-specific limit first, then server-level
    const toolLimiter = this.limiters.get(prefixedToolName);
    const serverLimiter = this.limiters.get(server);

    if (toolLimiter) await toolLimiter.acquire();
    if (serverLimiter) await serverLimiter.acquire();
  }
}

class TokenBucket {
  private queue: Array<() => void> = [];
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRate: number;  // tokens per ms

  constructor(config: { rpm?: number; rps?: number }) {
    if (config.rps) {
      this.maxTokens = config.rps;
      this.refillRate = config.rps / 1000;
    } else if (config.rpm) {
      this.maxTokens = Math.ceil(config.rpm / 60);
      this.refillRate = config.rpm / 60000;
    } else {
      this.maxTokens = Infinity;
      this.refillRate = Infinity;
    }
    this.tokens = this.maxTokens;
    // Start refill interval
  }

  async acquire(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return;
    }
    // Queue: resolve when token becomes available
    return new Promise((resolve) => {
      this.queue.push(resolve);
    });
  }
}
```

**Client-side timeout interaction**: The agent SDK (inside Docker container) has its own HTTP timeout for MCP tool calls. If the gateway queues a request for too long, the agent's HTTP client will timeout and close the connection. The gateway detects the closed connection and removes the request from the queue, freeing the slot. No special cancellation protocol needed — HTTP connection lifecycle handles it.

## Error Handling

| Error | Handling |
|-------|----------|
| Tool not in client's allowed list | 403 response |
| Unknown upstream server for tool prefix | 500 response (config error) |
| Upstream server not running (stdio) | 503 response, attempt restart if `autoRestart` |
| Upstream server timeout | 504 response |
| Upstream server crash (stdio) | Auto-restart if configured, 503 until recovered |
| Remote upstream unreachable | 503 response |
| Invalid MCP request | 400 response |
| No tool filter provided | Allow all tools (fully trusted) |
| Gateway shutdown during request | Complete in-flight requests, then close |

## Testing Approach

### Unit Tests

- **Tool filtering**: Glob matching, wildcard patterns (`vault:*`), exact match (`serpapi:search`), no filter = all
- **Header parsing**: `X-Tools` header parsing, comma-separated lists, missing header = all
- **Container config generation**: Correct URL + header construction

### Integration Tests

- **Full request flow**: Start gateway with mock stdio upstream → tools/list → tools/call → verify
- **Tool filtering enforcement**: Allowed tool succeeds, disallowed tool returns 403
- **Multi-upstream routing**: Tools from different upstreams correctly routed
- **Upstream lifecycle (stdio)**: Start, call, stop, crash, auto-restart
- **Concurrent requests**: Multiple simultaneous tool calls to same/different upstreams
- **Remote upstream (Streamable HTTP)**: Mock Streamable HTTP MCP server, verify passthrough
- **Rate limiting**: Requests queued at capacity, resolved FIFO when slots open
- **Rate limiting + client timeout**: Queued request removed when client connection closes

### Mock Strategy

Mock upstream MCP servers:
- Stdio: simple Bun process responding to MCP protocol
- Streamable HTTP: local HTTP server with MCP endpoints
- No real external APIs in tests

## File Structure

```
packages/mcp-gateway/src/
├── index.ts                    # Public API exports
├── gateway/
│   ├── create-gateway.ts       # createGateway() factory
│   ├── server.ts               # HTTP server setup and routing
│   └── types.ts                # GatewayConfig, Gateway, GatewayStatus
├── upstream/
│   ├── upstream-manager.ts     # Multi-upstream lifecycle and routing
│   ├── stdio-connection.ts     # Stdio MCP server management
│   ├── streamable-http-connection.ts  # Streamable HTTP MCP client
│   └── types.ts                # UpstreamServerConfig, UpstreamConnection
├── filter/
│   ├── tool-filter.ts          # Glob-based tool filtering + X-Tools header parsing
│   └── types.ts                # FilterConfig
├── rate-limit/
│   ├── rate-limiter.ts         # Unified rate limiter (token bucket + FIFO queue)
│   ├── token-bucket.ts         # Token bucket with queuing
│   └── types.ts                # RateLimitConfig
├── helpers/
│   └── mcp-config.ts           # mcpConfigForGateway() container helper
├── __tests__/
│   ├── tool-filter.test.ts
│   ├── rate-limiter.test.ts
│   ├── mcp-config.test.ts
│   └── integration/
│       ├── gateway.test.ts
│       └── upstream-manager.test.ts
└── __fixtures__/
    ├── mock-stdio-server.ts    # Minimal stdio MCP server for testing
    └── mock-streamable-http-server.ts  # Minimal Streamable HTTP MCP server for testing
```
