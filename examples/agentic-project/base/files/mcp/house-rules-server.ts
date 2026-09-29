// The house MCP server, over stdio: every agent in the project gets it from
// the house options, and it serves the rules the contracts cite.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { HOUSE_RULES, HouseRuleIdEnum } from '../house-rules.ts';

const server = new McpServer({ name: 'house', version: '1.0.0' });

server.registerTool(
  'lookup_rule',
  {
    description:
      'The full text of one house style rule, by id. Cite rules by these ids.',
    inputSchema: { id: HouseRuleIdEnum },
  },
  async ({ id }) => ({
    content: [{ type: 'text', text: `${id}: ${HOUSE_RULES[id]}` }],
  }),
);

await server.connect(new StdioServerTransport());
