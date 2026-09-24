import type { Envelope } from '../contract/envelope.ts';
import type { Outcome, PriorAttempt, RunRecord } from '../contract/task.ts';

/**
 * The task-process protocol: the executor and the process it spawns for one
 * task speak over Node's IPC channel, so nothing the task writes to stdout
 * can be mistaken for a message. One `run` in; any number of `record`s and
 * exactly one `outcome` out; a `cancel` may arrive at any time.
 */
export interface TaskInvocation {
  readonly taskId: string;
  readonly contextId: string;
  readonly runtimeSessionId: string;
  readonly attempt: number;
  readonly priorAttempt: PriorAttempt | undefined;
  readonly envelope: Envelope;
}

export type ExecutorMessage =
  | { readonly type: 'run'; readonly invocation: TaskInvocation }
  | { readonly type: 'cancel' };

export type TaskProcessMessage =
  | { readonly type: 'record'; readonly record: RunRecord }
  | { readonly type: 'outcome'; readonly outcome: Outcome };

/** Set on a spawned task process so it knows to wait for a `run`. */
export const taskProcessEnvironmentVariable = 'AGENTFORGE_TASK_PROCESS';
