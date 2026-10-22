/**
 * `@beruangai/agentforge/agent` — what every framework's procedures share:
 * filesystems, context composition, stop guards and the task's failures.
 * Each framework's own entry, such as `/claude/agent`, holds its procedures'
 * implementer and runs. Resolvable only under the `agentforge-agent` export
 * condition, so a worker's build cannot import it.
 */

export {
  Filesystem,
  type FilesystemOptions,
  type FilesystemRequest,
  type FilesystemScope,
  FilesystemUnsynced,
  type Mount,
  type MountedFilesystem,
  type Permission,
  type PermissionAction,
} from './filesystem/filesystem.ts';
export { filesystems } from './filesystem/registry.ts';
export {
  S3Filesystem,
  type S3FilesystemOptions,
} from './filesystem/s3-filesystem.ts';
export { ScratchFilesystem } from './filesystem/scratch-filesystem.ts';
export {
  type CacheBreakpoint,
  type ContextBlock,
  type ContextBlockFunction,
  type ContextContent,
  composeContext,
} from './prompt.ts';
export type { StopGuard, StopGuardDenial } from './stop-guard.ts';
export { TaskCanceled, TaskFailure } from './task-failure.ts';
