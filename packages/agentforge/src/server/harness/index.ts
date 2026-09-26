/**
 * `@beruangai/agentforge/agent` — what a consumer's agent build imports:
 * the task context its procedures receive, the kernel behind
 * `context.runAgent`, and the task process entry. Resolvable only under the
 * `agentforge-agent` export condition, so a worker's build cannot import it.
 */
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
export {
  executeProcedure,
  implementAgent,
  runTaskProcess,
  type TaskContext,
} from './task-process.ts';
export type {
  OpenWorkingDirectory,
  WorkingDirectorySpec,
  WorkingDirectorySync,
} from './working-directory.ts';
