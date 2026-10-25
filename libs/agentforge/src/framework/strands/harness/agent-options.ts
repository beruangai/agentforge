import { isAbsolute, matchesGlob, relative } from 'node:path';
import { tool } from '@strands-agents/sdk';
import { CedarAuthorization } from '@strands-agents/sdk/vended-interventions/cedar';
import { fileEditor } from '@strands-agents/sdk/vended-tools/file-editor';
import { z } from 'zod';
import type { MountedFilesystem } from '../../../server/harness/filesystem/filesystem.ts';
import { agentOptionsMiddleware } from '../../../server/harness/framework.ts';
import type { StrandsOptions } from './types.ts';

/** The API's limit on a tool's name. */
const TOOL_NAME_LIMIT = 64;

/** A mount's push tool: its message in, what it recorded out; a failure is the tool's error. */
function pushTool(name: string, push: NonNullable<MountedFilesystem['push']>) {
  const toolName = `push_${name}`;
  if (toolName.length > TOOL_NAME_LIMIT) {
    throw new Error(
      `filesystem "${name}" offers a push whose tool name, ${toolName}, is longer than ${TOOL_NAME_LIMIT} characters; register it under a shorter name`,
    );
  }
  return tool({
    name: toolName,
    description: `Commits and pushes the write scope of the "${name}" filesystem now, with your message, so partial work survives if the task fails. Returns the commit the write scope stands at and the files this push recorded, none when nothing changed.`,
    inputSchema: z.object({
      message: z.string().min(1).describe('The commit message'),
    }),
    callback: async ({ message }) => JSON.stringify(await push(message)),
  });
}

/** The vended file tool's commands that only read. */
const READ_COMMANDS = new Set(['view']);

/**
 * Every call is permitted, but an edit through the vended file tool outside
 * every mount's write scope. The enricher decides the scope, since a glob's
 * single-segment `*` is not a Cedar pattern.
 */
const WRITE_SCOPE_POLICY = `permit(principal, action, resource);
forbid(principal, action == Action::"${fileEditor.name}", resource)
  when { context.session.isWrite && !context.session.withinWriteScope };`;

/** Whether `path`, absolute, is inside one of the mounts' `edit` globs. */
export function withinWriteScope(
  mounts: readonly MountedFilesystem[],
  path: string,
): boolean {
  return mounts.some((mount) => {
    const inMount = relative(mount.localPath, path);
    if (inMount === '' || inMount.startsWith('..') || isAbsolute(inMount)) {
      return false;
    }
    return mount.permissions.some(
      ({ action, glob }) => action === 'edit' && matchesGlob(inMount, glob),
    );
  });
}

/**
 * The run options a procedure's mounts give a `strands` run: every mount as
 * a working directory, and one Cedar intervention refusing an edit through
 * the file tool outside every mount's write scope. What a shell command
 * writes is the procedure's allow list's, as for `claude`'s Bash; `delete`
 * renders nothing, since the file tool cannot delete. A mount that offers a
 * push gets a tool. Empty without mounts.
 */
export function toAgentOptions(
  filesystems: Readonly<Record<string, MountedFilesystem>>,
): Pick<StrandsOptions, 'workingDirectories' | 'interventions' | 'tools'> {
  const mounts = Object.values(filesystems);
  if (mounts.length === 0) return {};
  const pushTools = Object.entries(filesystems).flatMap(([name, mount]) =>
    mount.push === undefined ? [] : [pushTool(name, mount.push)],
  );
  return {
    ...(pushTools.length === 0 ? {} : { tools: pushTools }),
    workingDirectories: mounts.map((mount) => mount.localPath),
    interventions: [
      new CedarAuthorization({
        policies: WRITE_SCOPE_POLICY,
        contextEnricher: ({ toolName, toolInput }) => {
          if (toolName !== fileEditor.name) {
            return { isWrite: false, withinWriteScope: true };
          }
          const input = toolInput as { command?: unknown; path?: unknown };
          return {
            isWrite: !READ_COMMANDS.has(String(input.command)),
            withinWriteScope:
              typeof input.path === 'string' &&
              withinWriteScope(mounts, input.path),
          };
        },
      }),
    ],
  };
}

/** The `strands` framework's options middleware, appended after the mounts. */
export const strandsAgentOptionsMiddleware =
  agentOptionsMiddleware<StrandsOptions>(toAgentOptions);
