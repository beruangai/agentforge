import {
  activityInfo,
  cancellationSignal,
  heartbeat,
} from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import {
  awaitTask,
  type ProcedureClient,
  type Routed,
  type Starting,
  type TerminalTaskView,
} from '../client.ts';

export interface ProcedureActivityOptions<Input> {
  /** The runtime session to route to — the consumer's isolation choice (ADR 0007). */
  readonly runtimeSessionId: (input: Input) => string;
  /** Extra start fields: a continuity key, a time budget, metadata. */
  readonly start?: (
    input: Input,
  ) => Omit<Starting, 'runtimeSessionId' | 'idempotencyKey'>;
  readonly pollIntervalMilliseconds?: number;
  /** For the cancel after the activity is cancelled. */
  readonly cancelTask: (taskId: string, context: Routed) => Promise<unknown>;
}

/**
 * A Temporal activity that runs a procedure to its outcome: start (or attach),
 * poll with a heartbeat, and map the outcome onto Temporal's failures. The
 * idempotency key is the workflow run and activity id, so every retry of this
 * activity attaches to the same logical execution (ADR 0009).
 */
export function procedureActivity<Input, Output>(
  procedure: ProcedureClient<Input, Output>,
  options: ProcedureActivityOptions<Input>,
): (input: Input) => Promise<Output> {
  return async (input) => {
    const info = activityInfo();
    const workflow = info.workflowExecution;
    if (workflow === undefined) {
      throw ApplicationFailure.nonRetryable(
        'a procedure activity runs only inside a workflow: its idempotency key is the workflow run',
      );
    }
    const routed: Routed = {
      runtimeSessionId: options.runtimeSessionId(input),
    };
    const started = await procedure.SendMessage(input, {
      ...options.start?.(input),
      ...routed,
      idempotencyKey: `${workflow.workflowId}/${workflow.runId}/${info.activityId}`,
    });
    heartbeat({ taskId: started.taskId, state: started.state });
    const signal = cancellationSignal();
    let ended: TerminalTaskView<Output>;
    try {
      ended = await awaitTask(procedure, started, {
        ...routed,
        signal,
        ...(options.pollIntervalMilliseconds === undefined
          ? {}
          : { pollIntervalMilliseconds: options.pollIntervalMilliseconds }),
        onPoll: (task) => heartbeat({ taskId: task.taskId, state: task.state }),
      });
    } catch (error) {
      if (signal.aborted) {
        await options.cancelTask(started.taskId, routed);
        throw new CancelledFailure(
          'the activity was cancelled, and so was its task',
        );
      }
      throw error;
    }
    switch (ended.state) {
      case 'TASK_STATE_COMPLETED':
        return ended.output;
      case 'TASK_STATE_FAILED':
        throw ApplicationFailure.create({
          type: ended.cause.code,
          message: ended.cause.message,
          nonRetryable: !ended.cause.retryable,
          details: [ended.cause],
          ...(ended.cause.retryAfter === undefined
            ? {}
            : {
                nextRetryDelay: Math.max(
                  0,
                  Date.parse(ended.cause.retryAfter) - Date.now(),
                ),
              }),
        });
      case 'TASK_STATE_REJECTED':
        // Refused before any work: the same start would be refused again.
        throw ApplicationFailure.create({
          type: 'TASK_STATE_REJECTED',
          message: ended.reason,
          nonRetryable: true,
        });
      case 'TASK_STATE_CANCELED':
        // Someone else cancelled it: a new attempt may run.
        throw ApplicationFailure.create({
          type: 'TASK_STATE_CANCELED',
          message: `task ${ended.taskId} was cancelled by another caller`,
        });
    }
  };
}
