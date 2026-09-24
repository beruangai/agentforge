/**
 * `@beruangai/agentforge/agent` — what a consumer's agent build imports:
 * the task context its procedures receive, the kernel behind
 * `context.runAgent`, and the task process entry. Resolvable only under the
 * `agentforge-agent` export condition, so a worker's build cannot import it.
 */
export {
  type AgentOptions,
  type AgentPrompt,
  type AgentRun,
  type AgentRunSpec,
  runAgent,
  TaskCanceled,
  TaskFailure,
} from './kernel.ts';
export { composeOptions } from './options.ts';
export {
  executeProcedure,
  implementAgent,
  runTaskProcess,
  type TaskContext,
} from './task-process.ts';
