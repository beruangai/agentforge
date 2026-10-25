import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  type MountedFilesystem,
  pushToolDescription,
} from '../../../server/harness/filesystem/filesystem.ts';
import { agentOptionsMiddleware } from '../../../server/harness/framework.ts';
import type { AgentOptions } from './kernel.ts';
import { registeredSdkServer } from './sdk-mcp-servers.ts';

/** The SDK MCP server holding AgentForge's tools for a run. */
export const AGENTFORGE_MCP_SERVER = 'agentforge';
/** The API's limit on a tool's full name. */
const TOOL_NAME_LIMIT = 64;

/** The full name of a mount's push tool, as an allow rule names it. */
export function pushToolName(name: string): string {
  const full = `mcp__${AGENTFORGE_MCP_SERVER}__push_${name}`;
  if (full.length > TOOL_NAME_LIMIT) {
    throw new Error(
      `filesystem "${name}" offers a push whose tool name, ${full}, is longer than ${TOOL_NAME_LIMIT} characters; register it under a shorter name`,
    );
  }
  return full;
}

/** A push tool for each mount that offers one: its message in, what it recorded or why it failed out. */
function pushServer(
  offering: readonly (readonly [
    string,
    MountedFilesystem,
    NonNullable<MountedFilesystem['push']>,
  ])[],
) {
  return createSdkMcpServer({
    name: AGENTFORGE_MCP_SERVER,
    alwaysLoad: true,
    tools: offering.map(([name, mount, push]) =>
      tool(
        `push_${name}`,
        pushToolDescription(name, mount),
        { message: z.string().min(1).describe('The commit message') },
        async ({ message }) => {
          try {
            const report = await push(message);
            return {
              content: [{ type: 'text', text: JSON.stringify(report) }],
            };
          } catch (error) {
            return {
              isError: true,
              content: [
                {
                  type: 'text',
                  text: error instanceof Error ? error.message : String(error),
                },
              ],
            };
          }
        },
      ),
    ),
  });
}

/**
 * The run options a procedure's mounts give a `claude` run: every mount as an
 * additional directory, and every mount's baseline permissions as Claude
 * Code's allow rules — `Read` on the mount, `Edit` on each write glob;
 * `delete` renders nothing, since no tool deletes and a Bash rule cannot
 * bound paths. A mount that offers a push gets a tool, allowed, in the
 * `agentforge` SDK MCP server. Empty without mounts.
 */
export function toAgentOptions(
  filesystems: Readonly<Record<string, MountedFilesystem>>,
): Pick<AgentOptions, 'additionalDirectories' | 'allowedTools' | 'mcpServers'> {
  const mounts = Object.values(filesystems);
  if (mounts.length === 0) return {};
  const offering = Object.entries(filesystems).flatMap(([name, mount]) =>
    mount.push === undefined ? [] : [[name, mount, mount.push] as const],
  );
  const pushTools = offering.map(([name]) => pushToolName(name));
  return {
    additionalDirectories: mounts.map((mount) => mount.localPath),
    allowedTools: [
      ...new Set(
        mounts.flatMap((mount) =>
          mount.permissions.flatMap(({ action, glob }) =>
            action === 'delete'
              ? []
              : [
                  `${action === 'read' ? 'Read' : 'Edit'}(/${mount.localPath}/${glob})`,
                ],
          ),
        ),
      ),
      ...pushTools,
    ],
    ...(offering.length === 0
      ? {}
      : {
          mcpServers: {
            [AGENTFORGE_MCP_SERVER]: registeredSdkServer(() =>
              pushServer(offering),
            ),
          },
        }),
  };
}

/** The `claude` framework's options middleware, appended after the mounts. */
export const claudeAgentOptionsMiddleware =
  agentOptionsMiddleware<AgentOptions>(toAgentOptions);
