/**
 * `@beruangai/agentforge/agent` — what a consumer's agent build imports:
 * the task context its procedures receive, the kernel behind
 * `context.runAgent`, and the task process entry. Resolvable only under the
 * `agentforge-agent` export condition, so a worker's build cannot import it.
 */

export {
  DEFAULT_DISTILL_CAP_TOKENS,
  type DistillDocument,
  type DistillSpec,
  distill,
} from './distill.ts';
export {
  Filesystem,
  type FilesystemOptions,
  type FilesystemRequest,
  type FilesystemScope,
  FilesystemUnsynced,
  type Mount,
  type MountedFilesystem,
} from './filesystem/filesystem.ts';
export { filesystems } from './filesystem/registry.ts';
export {
  S3Filesystem,
  type S3FilesystemOptions,
} from './filesystem/s3-filesystem.ts';
export { ScratchFilesystem } from './filesystem/scratch-filesystem.ts';
export {
  type AgentOptions,
  type AgentRun,
  type AgentRunSpec,
  runAgent,
  TaskCanceled,
  TaskFailure,
} from './kernel.ts';
export { composeOptions } from './options.ts';
export {
  type AgentPrompt,
  type CacheBreakpoint,
  type CommandBlock,
  type ContentBlock,
  type ContextBlock,
  type ContextDocument,
  documentBlock,
  type PromptContent,
} from './prompt.ts';
export type {
  StopGuard,
  StopGuardDenial,
} from './structured-output-validation.ts';
export {
  executeProcedure,
  implementAgent,
  runTaskProcess,
  type TaskContext,
} from './task-process.ts';
