import { resolve } from 'node:path';
import { os } from '@orpc/server';
import { FILESYSTEM_NAME_PATTERN } from '#core/filesystem.ts';
import type { TaskContext } from '../task-process.ts';
import type {
  Filesystem,
  Mount,
  MountedFilesystem,
  MountLifecycle,
} from './filesystem.ts';
import { isWithin } from './mount-claims.ts';

/**
 * Where registrations accumulate on the context, until the lifecycle mounts
 * them. A string key and a type alias, not a symbol and an interface: a
 * consumer that emits declarations for a router using `filesystems()` must be
 * able to write its context's type, and neither is exported.
 */
const FILESYSTEM_REGISTRY = 'agentforge.filesystems';

type Registry = Readonly<Record<string, Filesystem>>;

type RegistryContext = { readonly [FILESYSTEM_REGISTRY]?: Registry };

/**
 * Registers filesystems for the procedures under it, by name: added to what
 * is registered upstream, a name already there replaced. With
 * `replaceUpstream: true`, everything registered upstream is dropped. Nothing is mounted here;
 * AgentForge mounts what is registered just before the handler (ADR 0015).
 */
export function filesystems(
  entries: Readonly<Record<string, Filesystem>>,
  options: { readonly replaceUpstream?: boolean } = {},
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
          ...(options.replaceUpstream === true
            ? {}
            : context[FILESYSTEM_REGISTRY]),
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
      // Every scope resolves first, so a clash is refused before anything mounts.
      const resolved = Object.entries(context[FILESYSTEM_REGISTRY] ?? {}).map(
        ([name, filesystem]) =>
          [
            filesystem,
            filesystem.resolve({
              name,
              taskId: context.taskId,
              request: { input, context },
            }),
          ] as const,
      );
      refuseOverlappingMounts(resolved.map(([, mount]) => mount));
      const filesystems: Record<string, MountedFilesystem> = {};
      for (const [filesystem, mount] of resolved) {
        const lifecycle = await filesystem.mount(mount);
        lifecycles.push(lifecycle);
        filesystems[mount.name] = lifecycle.mounted;
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

/**
 * Refuses, before anything is mounted, two filesystems at one local
 * directory or one inside the other: each removes its own at unmount, and
 * unmounts run concurrently, so one's removal could race the other's push.
 */
function refuseOverlappingMounts(mounts: readonly Mount[]): void {
  const localPaths = mounts.map(
    (mount) => [mount.name, resolve(mount.localPath)] as const,
  );
  for (const [index, [name, localPath]] of localPaths.entries()) {
    for (const [otherName, otherLocalPath] of localPaths.slice(index + 1)) {
      if (
        isWithin(localPath, otherLocalPath) ||
        isWithin(otherLocalPath, localPath)
      ) {
        throw new Error(
          `filesystems "${name}" (${localPath}) and "${otherName}" (${otherLocalPath}) mount at the same directory or one inside the other`,
        );
      }
    }
  }
}
