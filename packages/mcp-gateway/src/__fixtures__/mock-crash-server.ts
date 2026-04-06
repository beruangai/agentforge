#!/usr/bin/env node
/**
 * Mock MCP server that initializes successfully then exits immediately.
 * Used to test 503 behavior when an upstream crashes after connection.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'mock-crash-server',
  version: '1.0.0',
});

server.tool(
  'echo',
  'Echoes back the input',
  { message: z.string() },
  async ({ message }) => ({
    content: [{ type: 'text' as const, text: message }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Exit after a brief delay to ensure initialization completes
setTimeout(() => {
  process.exit(0);
}, 200);
