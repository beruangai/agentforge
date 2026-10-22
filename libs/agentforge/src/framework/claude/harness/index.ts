/**
 * `@beruangai/agentforge/claude/agent` — what a `claude` project's procedures
 * import beside `/agent`: the implementer and the task process entry bound to
 * the Claude Agent SDK, the kernel behind `context.runAgent`, and Claude's
 * prompt content. Resolvable only under the `agentforge-agent` export
 * condition, so a worker's build cannot import it.
 */
import type { RouterContract } from '@orpc/contract';
import type { Router } from '@orpc/server';
import {
  implementAgent as implementSharedAgent,
  runTaskProcess as runSharedTaskProcess,
} from '../../../server/harness/task-process.ts';
import { framework } from './framework.ts';
import type { TaskContext } from './kernel.ts';

export {
  DEFAULT_DISTILL_CAP_TOKENS,
  type DistillDocument,
  type DistillSpec,
  distill,
} from './distill.ts';
export { framework } from './framework.ts';
export {
  type AgentOptions,
  type AgentRun,
  type AgentRunSpec,
  type ClaudeTypes,
  runAgent,
  type TaskContext,
} from './kernel.ts';
export { composeOptions } from './options.ts';
export {
  type AgentPrompt,
  type CommandBlock,
  type ContentBlock,
  type ContextBlockFunction,
  type ContextContent,
  type ContextDocument,
  documentBlock,
  type PromptContent,
} from './prompt.ts';

/**
 * The oRPC implementer for a contract, with the `claude` task context. A
 * contract that would drop undeclared keys is refused (§REQ103), so the
 * procedure module that calls this fails to load.
 */
export function implementAgent<Contract extends RouterContract>(
  contract: Contract,
) {
  return implementSharedAgent(framework, contract).$context<TaskContext>();
}

/**
 * The entry point of a spawned task process: waits for its one `run`, runs
 * it, reports the outcome, and exits. Called from the consumer's task entry,
 * the one place the harness and the consumer's procedures meet.
 */
export function runTaskProcess(options: {
  readonly contract: RouterContract;
  readonly router: Router<TaskContext>;
}): void {
  runSharedTaskProcess({ framework, ...options });
}
