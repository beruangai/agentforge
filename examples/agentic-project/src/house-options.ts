import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import type { AgentOptions } from '@beruangai/agentforge/agent';

/** What the agents edit: the base image's workspace, and every run's `cwd`. */
export const WORKSPACE = '/mnt/workspace';

/** The layer's Claude-facing files: `CLAUDE.md` and `.claude/skills`. */
const CLAUDE_DIRECTORY = '/agentic/claude';

/** The house MCP server's one tool, as the session names it. */
export const LOOKUP_RULE_TOOL = 'mcp__house__lookup_rule';

/** File tools stay inside the workspace; anything else is denied in the turn. */
const stayInWorkspace: HookCallback = async (input) => {
  const toolInput = (input as { tool_input?: { file_path?: unknown } })
    .tool_input;
  const filePath = toolInput?.file_path;
  if (typeof filePath === 'string' && !filePath.startsWith(`${WORKSPACE}/`)) {
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `only files under ${WORKSPACE} may be read or changed`,
      },
    };
  }
  return {};
};

/**
 * What every agent in this project runs with, composed under each agent's own
 * options with `composeOptions` (§REQ204): the workspace as `cwd`; the
 * layer's skill and `CLAUDE.md` through `additionalDirectories`, which loads
 * skills through the `project` setting source and `CLAUDE.md` only with its
 * variable set; the house MCP server; and the workspace guard.
 */
export const houseOptions: AgentOptions = {
  cwd: WORKSPACE,
  model: 'claude-sonnet-5',
  settingSources: ['project'],
  additionalDirectories: [CLAUDE_DIRECTORY],
  env: { CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1' },
  mcpServers: {
    house: {
      type: 'stdio',
      command: 'bun',
      args: ['/agentic/mcp/house-rules-server.ts'],
    },
  },
  tools: ['Read', 'Glob', 'Grep', 'Skill'],
  allowedTools: ['Skill', LOOKUP_RULE_TOOL],
  hooks: {
    PreToolUse: [{ matcher: 'Read|Write|Edit', hooks: [stayInWorkspace] }],
  },
};
