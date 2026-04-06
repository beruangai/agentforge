/**
 * Minimal Streamable HTTP MCP server for testing.
 * Uses the McpServer + StreamableHTTPServerTransport from the SDK.
 */
import { createServer, type Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';

export async function startMockStreamableHttpServer(
  port: number,
): Promise<Server> {
  // Use a map to track transports per session for stateful mode
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function createMcpServer(): McpServer {
    const mcpServer = new McpServer({
      name: 'mock-http-server',
      version: '1.0.0',
    });

    mcpServer.tool(
      'search',
      'Search for something',
      { query: z.string() },
      async ({ query }) => ({
        content: [{ type: 'text' as const, text: `results for: ${query}` }],
      }),
    );

    mcpServer.tool(
      'fetch',
      'Fetch a resource',
      { url: z.string() },
      async ({ url }) => ({
        content: [{ type: 'text' as const, text: `fetched: ${url}` }],
      }),
    );

    return mcpServer;
  }

  const httpServer = createServer(async (req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404);
      res.end();
      return;
    }

    // Check for existing session
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Existing session — reuse transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // New session — create new transport and server
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) transports.delete(sid);
    };

    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);

    // Store transport by session ID after handling the first request
    await transport.handleRequest(req, res);

    if (transport.sessionId) {
      transports.set(transport.sessionId, transport);
    }
  });

  return new Promise((resolve) => {
    httpServer.listen(port, '127.0.0.1', () => {
      resolve(httpServer);
    });
  });
}
