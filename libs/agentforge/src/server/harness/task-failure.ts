import type { Cause } from '#core/contract/task.ts';

/** A run that ended on its own terms without an answer: the task fails with this cause. */
export class TaskFailure extends Error {
  readonly taskCause: Cause;

  constructor(taskCause: Cause) {
    super(`${taskCause.code}: ${taskCause.message}`);
    this.taskCause = taskCause;
    this.name = 'TaskFailure';
  }
}

/** The run was cancelled; the task ends `TASK_STATE_CANCELED`. */
export class TaskCanceled extends Error {
  constructor() {
    super('the task was cancelled');
    this.name = 'TaskCanceled';
  }
}

/** An error as a cause's message gives it: its name and message. */
export function describeError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}
