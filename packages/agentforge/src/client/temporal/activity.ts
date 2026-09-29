import { setTimeout as delay } from 'node:timers/promises';
import {
  activityInfo,
  cancellationSignal,
  heartbeat,
} from '@temporalio/activity';
import { ApplicationFailure, CancelledFailure } from '@temporalio/common';
import {
  awaitTask,
  DEFAULT_POLL_INTERVAL_MILLISECONDS,
  type ProcedureClient,
  type Routed,
  type Starting,
  type TaskView,
  type TerminalTaskView,
} from '../client.ts';
import { StartRefusedError } from '../transport.ts';

/**
 * How long one attempt waits out refused starts, counted from its first
 * refusal and not rolling. Past it, the attempt fails retryable and Temporal
 * delays the next attempt to the refusal's time.
 */
const REFUSAL_WAIT_BUDGET_SECONDS = 900;

export interface ProcedureActivityOptions<Input> {
  /** The runtime session to route to — the consumer's isolation choice (ADR 0007). */
  readonly runtimeSessionId: (input: Input) => string;
  /** Extra start fields: a continuity key, a time budget, metadata. */
  readonly start?: (
    input: Input,
  ) => Omit<Starting, 'runtimeSessionId' | 'idempotencyKey'>;
  /** How often a running task is polled, and a refused start's wait heartbeats. */
  readonly pollIntervalMilliseconds?: number;
  /** For the cancel after the activity is cancelled. */
  readonly cancelTask: (taskId: string, context: Routed) => Promise<unknown>;
}

/**
 * A Temporal activity that runs a procedure to its outcome: start (or attach),
 * poll with a heartbeat, and map the outcome onto Temporal's failures. The
 * idempotency key is the workflow run and activity id, so every retry of this
 * activity attaches to the same logical execution (ADR 0009).
 *
 * A start the agent refuses for now is waited out and started again, for up
 * to 15 minutes of waiting per attempt; past that, the attempt fails
 * retryable, its next attempt delayed to the refusal's time. So a caller sets
 * (research/temporal.md):
 * - `startToCloseTimeout`, which bounds each attempt, to the task's time
 *   budget plus up to 15 minutes of waiting;
 * - `maximumAttempts` counting wait budgets spent, not refusals;
 * - `scheduleToCloseTimeout`, which the delays between attempts count
 *   toward, and the workflow's own timeouts, wide enough for the waits, or
 *   unset. Temporal ends the activity at once, failed, when a delay would
 *   pass `scheduleToCloseTimeout`, and workflow code cannot widen an
 *   activity's options once it is scheduled;
 * - `heartbeatTimeout`, if any, above the poll interval, at which a wait
 *   heartbeats too.
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
    const starting: Starting = {
      ...options.start?.(input),
      ...routed,
      idempotencyKey: `${workflow.workflowId}/${workflow.runId}/${info.activityId}`,
    };
    const signal = cancellationSignal();
    const pollIntervalMilliseconds =
      options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
    const started = await startWaitingOutRefusals(
      () => procedure.SendMessage(input, starting),
      signal,
      pollIntervalMilliseconds,
    );
    heartbeat({ taskId: started.taskId, state: started.state });
    let ended: TerminalTaskView<Output>;
    try {
      ended = await awaitTask(procedure, started, {
        ...routed,
        signal,
        pollIntervalMilliseconds,
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

/**
 * Starts, waiting out each refused start and starting again with the same
 * fields and key — a refusal bound nothing — until the attempt's wait budget
 * would be passed. The wait heartbeats, and ends at once when the activity is
 * cancelled: no task was started, so there is nothing to cancel.
 */
async function startWaitingOutRefusals<Output>(
  start: () => Promise<TaskView<Output>>,
  signal: AbortSignal,
  heartbeatIntervalMilliseconds: number,
): Promise<TaskView<Output>> {
  let firstRefusedAt: number | undefined;
  for (;;) {
    let refused: StartRefusedError;
    try {
      return await start();
    } catch (error) {
      if (!(error instanceof StartRefusedError)) throw error;
      refused = error;
    }
    firstRefusedAt ??= Date.now();
    const retryAt = refused.retryAfter.getTime();
    if (retryAt - firstRefusedAt > REFUSAL_WAIT_BUDGET_SECONDS * 1_000) {
      throw ApplicationFailure.create({
        type: refused.refusal,
        message: `${refused.message}; past this attempt's ${REFUSAL_WAIT_BUDGET_SECONDS}s of waiting, retry after ${refused.retryAfter.toISOString()}`,
        nonRetryable: false,
        nextRetryDelay: refused.retryAfterSeconds * 1_000,
      });
    }
    try {
      for (
        let remaining = retryAt - Date.now();
        remaining > 0;
        remaining = retryAt - Date.now()
      ) {
        heartbeat({
          refusal: refused.refusal,
          retryAfter: refused.retryAfter.toISOString(),
        });
        await delay(
          Math.min(remaining, heartbeatIntervalMilliseconds),
          undefined,
          { signal },
        );
      }
    } catch (error) {
      if (signal.aborted) {
        throw new CancelledFailure(
          'the activity was cancelled while it waited out a refused start; no task was started',
        );
      }
      throw error;
    }
  }
}
