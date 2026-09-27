import { os } from '@orpc/server';
import { FILESYSTEM_NAME_PATTERN } from '#core/filesystem.ts';
import type { TaskContext } from '../task-process.ts';
import type {
  Filesystem,
  MountedFilesystem,
  MountLifecycle,
} from './filesystem.ts';

/** Where registrations accumulate on the context, until the lifecycle mounts them. */
const FILESYSTEM_REGISTRY = Symbol('agentforge.filesystems');

type Registry = Readonly<Record<string, Filesystem>>;

interface RegistryContext {
  readonly [FILESYSTEM_REGISTRY]?: Registry;
}

/**
 * Registers filesystems for the procedures under it, by name: added to what
 * is registered upstream, a name already there replaced. With
 * `inherit: false`, everything upstream is dropped. Nothing is mounted here;
 * AgentForge mounts what is registered just before the handler (ADR 0015).
 */
export function filesystems(
  entries: Readonly<Record<string, Filesystem>>,
  options: { readonly inherit?: boolean } = {},
) {
  for (const name of Object.keys(entries)) {
    if (!FILESYSTEM_NAME_PATTERN.test(name)) {
      throw new Error(
        `filesystem "${name}" must be named to match ${FILESYSTEM_NAME_PATTERN}`,
      );
    }
  }
  return os.$context<RegistryContext>().middleware(({ context, next }) =>
    next({
      context: {
        [FILESYSTEM_REGISTRY]: {
          ...(options.inherit === false ? {} : context[FILESYSTEM_REGISTRY]),
          ...entries,
        },
      },
    }),
  );
}

/**
 * The innermost middleware, appended by the harness to the procedure it
 * calls: mounts every registered filesystem and hands the handler their
 * paths and baseline permissions. Each mount joins `lifecycles` as it
 * succeeds, for the harness to unmount once the outcome is known.
 */
export function mountRegisteredFilesystems(lifecycles: MountLifecycle[]) {
  return os
    .$context<TaskContext & RegistryContext>()
    .middleware(async ({ context, next }, input) => {
      const filesystems: Record<string, MountedFilesystem> = {};
      for (const [name, filesystem] of Object.entries(
        context[FILESYSTEM_REGISTRY] ?? {},
      )) {
        const lifecycle = await filesystem.mount({
          name,
          taskId: context.taskId,
          request: { input, context },
        });
        lifecycles.push(lifecycle);
        filesystems[name] = lifecycle.mounted;
      }
      const allow = Object.values(filesystems).flatMap(
        (filesystem) => filesystem.permissions.allow,
      );
      return next({
        context: {
          filesystems,
          filesystemPermissions: { allow: [...new Set(allow)] },
        },
      });
    });
}
