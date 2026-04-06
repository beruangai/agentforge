#!/usr/bin/env node
/**
 * Minimal stdio MCP server for testing.
 * Responds to initialize, tools/list, and tools/call.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'mock-server',
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

server.tool(
  'greet',
  'Returns a greeting',
  { name: z.string() },
  async ({ name }) => ({
    content: [{ type: 'text' as const, text: `Hello, ${name}!` }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
