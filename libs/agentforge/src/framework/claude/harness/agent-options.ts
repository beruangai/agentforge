import type { MountedFilesystem } from '../../../server/harness/filesystem/filesystem.ts';
import { agentOptionsMiddleware } from '../../../server/harness/framework.ts';
import type { AgentOptions } from './kernel.ts';

/**
 * The run options a procedure's mounts give a `claude` run: every mount as an
 * additional directory, and every mount's baseline permissions as Claude
 * Code's allow rules — `Read` on the mount, `Edit` on each write glob. Empty
 * without mounts.
 */
export function toAgentOptions(
  filesystems: Readonly<Record<string, MountedFilesystem>>,
): Pick<AgentOptions, 'additionalDirectories' | 'allowedTools'> {
  const mounts = Object.values(filesystems);
  if (mounts.length === 0) return {};
  return {
    additionalDirectories: mounts.map((mount) => mount.localPath),
    allowedTools: [
      ...new Set(
        mounts.flatMap((mount) =>
          mount.permissions.map(
            ({ action, glob }) =>
              `${action === 'read' ? 'Read' : 'Edit'}(/${mount.localPath}/${glob})`,
          ),
        ),
      ),
    ],
  };
}

/** The `claude` framework's options middleware, appended after the mounts. */
export const claudeAgentOptionsMiddleware =
  agentOptionsMiddleware<AgentOptions>(toAgentOptions);
