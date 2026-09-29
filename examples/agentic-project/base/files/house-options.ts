import { fileURLToPath } from 'node:url';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AgentOptions } from '@beruangai/agentforge/agent';

/** The house MCP server's one tool, as the session names it. */
export const LOOKUP_RULE_TOOL = 'mcp__house__lookup_rule';

const HOUSE_RULES_SERVER = fileURLToPath(
  new URL('./mcp/house-rules-server.ts', import.meta.url),
);

/** File tools stay inside the working directory; anything else is denied in the turn. */
function stayInWorkingDirectory(workingDirectory: string): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') {
      throw new Error(
        `stayInWorkingDirectory is a PreToolUse hook, called for ${input.hook_event_name}`,
      );
    }
    const toolInput = input.tool_input;
    if (
      typeof toolInput === 'object' &&
      toolInput !== null &&
      'file_path' in toolInput &&
      typeof toolInput.file_path === 'string' &&
      !toolInput.file_path.startsWith(`${workingDirectory}/`)
    ) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `only files under ${workingDirectory} may be read or changed`,
        },
      };
    }
    return {};
  };
}

/**
 * What every agent in this project runs with, composed under each agent's own
 * options with `composeOptions` (§REQ204). The cwd stays the agent's
 * directory, so the `project` setting source composes the layer's
 * `.claude/` — its skill and `CLAUDE.md` — from the parent. The caller's
 * files live in a working directory the procedure chooses: added through
 * `additionalDirectories`, and the only place file tools may reach.
 */
export function houseOptions(workingDirectory: string): AgentOptions {
  return {
    model: 'claude-sonnet-5',
    settingSources: ['project'],
    additionalDirectories: [workingDirectory],
    mcpServers: {
      house: { type: 'stdio', command: 'bun', args: [HOUSE_RULES_SERVER] },
    },
    tools: ['Read', 'Glob', 'Grep', 'Skill'],
    allowedTools: ['Skill', LOOKUP_RULE_TOOL],
    hooks: {
      PreToolUse: [
        {
          matcher: 'Read|Write|Edit',
          hooks: [stayInWorkingDirectory(workingDirectory)],
        },
      ],
    },
  };
}
