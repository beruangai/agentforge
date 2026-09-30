import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import { KATA_FILE, SOLUTION_FILE } from './kata.ts';
import { runCases } from './run-cases.ts';

/** The `kata` server's one tool, as a session names it. */
export const RUN_CASES_TOOL = 'mcp__kata__run_cases';

/**
 * The `kata` MCP server, in the agent's own process: its one tool runs the
 * kata in `directory` against the solution there. A kata that cannot be run
 * is the tool's error, which the agent reads and can fix.
 */
export function kataServer(directory: string): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: 'kata',
    version: '1.0.0',
    alwaysLoad: true,
    tools: [
      tool(
        'run_cases',
        `Runs every case in ${directory}/${KATA_FILE} against the function ${directory}/${SOLUTION_FILE} exports, each in its own process, and reports which pass.`,
        {},
        async () => {
          try {
            const results = await runCases(directory);
            return {
              content: [
                { type: 'text', text: JSON.stringify(results, null, 2) },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `The kata could not be run: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
