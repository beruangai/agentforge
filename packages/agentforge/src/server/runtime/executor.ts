import { type ChildProcess, spawn } from 'node:child_process';
import { type Task, taskStateFromJSON } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { z } from 'zod';
import type { Envelope } from '#core/contract/envelope.ts';
import {
  cause,
  type Outcome,
  type PriorAttempt,
  type RunRecord,
} from '#core/contract/task.ts';
import { OPERATIONAL_METRICS } from '#core/metrics.ts';
import {
  type ExecutorMessage,
  TASK_PROCESS_ENVIRONMENT_VARIABLE,
  type TaskInvocation,
  TaskProcessMessageSchema,
} from '#core/task-protocol/messages.ts';
import { finishedTask, newTask, readEnvelope } from './a2a-task.ts';
import type { OperationalMetrics } from './metrics.ts';
import type { DynamoDBTaskStore } from './task-store.ts';

/** What the gateway decided about a start, handed to the executor on the message. */
export interface Admission {
  readonly runtimeSessionId: string;
  readonly attempt: number;
  readonly priorAttempt: PriorAttempt | undefined;
  /** Names this start, so the gateway can stop what it spawned if the start then fails. */
  readonly startId: string;
}
export const ADMISSION_METADATA_KEY = 'agentforge.admission';

/** Why a start is refused once the container has begun to stop. */
export const CONTAINER_STOPPING_REASON =
  'the container is stopping; start the task again, and a new container will run it';

export interface ExecutorConfig {
  /** The command that starts a task process: the runtime, its flags, the consumer's task entry. */
  readonly taskCommand: readonly string[];
  readonly defaultTimeBudgetSeconds: number;
  /** How long a stopping task process gets before its process group is killed. */
  readonly graceMilliseconds: number;
  readonly store: Pick<DynamoDBTaskStore, 'save' | 'renewLease'>;
  readonly metrics: OperationalMetrics;
}

/** Why the executor stopped a task. */
export type StopReason =
  | 'CANCEL'
  | 'TIMEOUT'
  | 'SHUTDOWN'
  /** Its lease could not be renewed: a reader already derived it lost. */
  | 'LEASE_LOST'
  /** The start that spawned it failed, so nothing the caller holds names it. */
  | 'START_FAILED';

interface LiveTask {
  readonly child: ChildProcess;
  readonly continuityKey: string | undefined;
  readonly startId: string;
  readonly finished: Promise<void>;
  readonly records: RunRecord[];
  /** The outcome the task process reported, once it has. */
  reported: Outcome | undefined;
  /** Why it was stopped, when that was before it reported. */
  stopReason: StopReason | undefined;
  stopRequested: boolean;
}

const LEASE_RENEWAL_MILLISECONDS = 20_000;
const STDERR_TAIL_BYTES = 4_000;

/**
 * Runs each task in a process of its own, in its own process group, so a
 * task cannot stall the server and cancelling it takes everything it started
 * (ADR 0004). The executor, not the task, owns the time budget.
 */
export class TaskProcessExecutor implements AgentExecutor {
  readonly #live = new Map<string, LiveTask>();
  #stopping = false;

  readonly #config: ExecutorConfig;
  readonly #command: string;

  constructor(config: ExecutorConfig) {
    const [command] = config.taskCommand;
    if (command === undefined || command === '') {
      throw new Error('the executor needs a command to start a task process');
    }
    this.#config = config;
    this.#command = command;
  }

  get liveCount(): number {
    return this.#live.size;
  }

  /** Set once the container begins to stop: from then on, no task starts. */
  get stopping(): boolean {
    return this.#stopping;
  }

  isLive(taskId: string): boolean {
    return this.#live.has(taskId);
  }

  hasLiveContinuityKey(continuityKey: string): boolean {
    return [...this.#live.values()].some(
      (task) => task.continuityKey === continuityKey,
    );
  }

  async execute(
    requestContext: RequestContext,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const { taskId, contextId } = requestContext;
    const message = requestContext.userMessage;
    const envelope = readEnvelope(message);
    const admission = message.metadata?.[ADMISSION_METADATA_KEY] as
      | Admission
      | undefined;
    if (admission === undefined) {
      throw new Error('the start did not pass through the gateway');
    }
    const submitted = newTask({
      id: taskId,
      contextId,
      state: 'TASK_STATE_SUBMITTED',
      metadata: taskMetadata(envelope, admission),
    });
    // Published before the first await: `returnImmediately` resolves on it.
    eventBus.publish(AgentEvent.task(submitted));

    if (this.#stopping) {
      // Admitted as the container began to stop: refused as the gateway
      // now refuses a start, and nothing is spawned for the shutdown to miss.
      try {
        await this.#record(
          submitted,
          { state: 'TASK_STATE_REJECTED', reason: CONTAINER_STOPPING_REASON },
          [],
          eventBus,
        );
      } finally {
        eventBus.finished();
      }
      return;
    }

    const invocation: TaskInvocation = {
      taskId,
      contextId,
      runtimeSessionId: admission.runtimeSessionId,
      attempt: admission.attempt,
      ...(admission.priorAttempt === undefined
        ? {}
        : { priorAttempt: admission.priorAttempt }),
      envelope,
    };
    const { promise: finished, resolve: markFinished } =
      Promise.withResolvers<void>();
    let stderrTail = '';
    let runUndelivered: Error | undefined;

    const child = spawn(this.#command, this.#config.taskCommand.slice(1), {
      stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
      detached: true,
      serialization: 'json',
      env: { ...process.env, [TASK_PROCESS_ENVIRONMENT_VARIABLE]: '1' },
    });
    const live: LiveTask = {
      child,
      continuityKey: envelope.continuityKey,
      startId: admission.startId,
      finished,
      records: [],
      reported: undefined,
      stopReason: undefined,
      stopRequested: false,
    };
    this.#live.set(taskId, live);
    let lease: NodeJS.Timeout | undefined;
    let budget: NodeJS.Timeout | undefined;

    try {
      child.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
      });
      child.on('message', (received: unknown) => {
        receive(taskId, live, received);
      });
      const exited = new Promise<{
        code: number | null;
        signal: string | null;
        error?: Error;
      }>((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }));
        // More than one may come — a failed spawn, then the failed send of
        // `run` — and one from a process that runs on, such as a failed kill.
        child.on('error', (error) => {
          if (child.pid === undefined) {
            resolve({ code: null, signal: null, error });
          } else {
            console.error(
              `task ${taskId}: its process reported an error`,
              error,
            );
          }
        });
      });
      sendTo(child, taskId, { type: 'run', invocation }, (error) => {
        // A process that never receives its run can only wait: end it.
        runUndelivered = error;
        killGroup(child);
      });

      eventBus.publish(
        AgentEvent.task({
          ...submitted,
          status: {
            ...statusOf(submitted),
            state: taskStateFromJSON('TASK_STATE_WORKING'),
          },
        }),
      );

      lease = setInterval(() => {
        this.#config.store
          .renewLease(taskId)
          .then((renewed) => {
            if (renewed) return;
            console.error(
              `task ${taskId}: its stored task has already ended — derived lost — so it is stopped, and no new attempt runs alongside it`,
            );
            return this.stop(taskId, 'LEASE_LOST');
          })
          .catch((error: unknown) => {
            console.error(
              `task ${taskId}: the lease could not be renewed`,
              error,
            );
          });
      }, LEASE_RENEWAL_MILLISECONDS);
      const budgetSeconds =
        envelope.timeBudgetSeconds ?? this.#config.defaultTimeBudgetSeconds;
      budget = setTimeout(() => {
        void this.stop(taskId, 'TIMEOUT');
      }, budgetSeconds * 1000);

      const exit = await exited;
      if (live.stopReason === 'LEASE_LOST') {
        // The stored loss is the record; the store refuses any write over it.
        return;
      }
      const outcome = settledOutcome({
        reported: live.reported,
        stopReason: live.stopReason,
        budgetSeconds,
        exit:
          exit.error === undefined && runUndelivered !== undefined
            ? { ...exit, error: runUndelivered }
            : exit,
        stderrTail,
      });
      await this.#record(submitted, outcome, live.records, eventBus);
    } finally {
      clearInterval(lease);
      clearTimeout(budget);
      this.#live.delete(taskId);
      killGroup(child);
      eventBus.finished();
      markFinished();
    }
  }

  /**
   * Saves the task as it ended, then publishes it: stored first, so a caller
   * reading the store after a cancel or a poll sees the end, not the SDK's
   * write still in flight.
   */
  async #record(
    submitted: Task,
    outcome: Outcome,
    records: readonly RunRecord[],
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    const finished = finishedTask(submitted, outcome, { runs: records });
    try {
      await this.#config.store.save(finished);
    } catch (error) {
      this.#config.metrics.count(
        OPERATIONAL_METRICS.OUTCOME_UNRECORDED,
        submitted.id,
      );
      throw error;
    }
    eventBus.publish(AgentEvent.task(finished));
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.stop(taskId, 'CANCEL');
  }

  /**
   * Asks the task process to stop, and kills its process group after the
   * grace period whatever it is doing. Resolves once the task has finished.
   * The first stop decides; once the process has reported its outcome, that
   * outcome stands, and a stop only ends the process.
   */
  async stop(taskId: string, reason: StopReason): Promise<void> {
    const live = this.#live.get(taskId);
    if (live === undefined) return;
    if (!live.stopRequested) {
      live.stopRequested = true;
      if (live.reported === undefined) {
        live.stopReason = reason;
        if (reason === 'SHUTDOWN') {
          this.#config.metrics.count(
            OPERATIONAL_METRICS.STOPPED_MID_TURN,
            taskId,
          );
        }
      }
      if (live.child.connected) {
        sendTo(live.child, taskId, { type: 'cancel' });
      }
      const kill = setTimeout(() => {
        this.#config.metrics.count(
          OPERATIONAL_METRICS.KILLED_AFTER_GRACE,
          taskId,
        );
        killGroup(live.child);
      }, this.#config.graceMilliseconds);
      void live.finished.then(() => clearTimeout(kill));
    }
    await live.finished;
  }

  /** Stops the task a start spawned when that start then failed: nothing the caller holds names it. */
  async stopFailedStart(startId: string): Promise<void> {
    const started = [...this.#live].find(
      ([, task]) => task.startId === startId,
    );
    if (started === undefined) return;
    await this.stop(started[0], 'START_FAILED');
  }

  /**
   * On SIGTERM: no task starts from here on, and every live task stops, and
   * is recorded lost rather than left to its lease.
   */
  async shutdown(): Promise<void> {
    this.#stopping = true;
    await Promise.all(
      [...this.#live.keys()].map((taskId) => this.stop(taskId, 'SHUTDOWN')),
    );
  }
}

/** One message from a task process, parsed: anything outside the protocol is logged, never trusted. */
function receive(taskId: string, live: LiveTask, received: unknown): void {
  const parsed = TaskProcessMessageSchema.safeParse(received);
  if (!parsed.success) {
    console.error(
      `task ${taskId}: its process sent a message outside the protocol, ignored: ${z.prettifyError(parsed.error)}`,
    );
    return;
  }
  const message = parsed.data;
  if (message.type === 'record') {
    live.records.push(message.record);
    return;
  }
  if (live.reported !== undefined) {
    console.error(
      `task ${taskId}: its process reported a second outcome, ignored`,
      message.outcome,
    );
    return;
  }
  live.reported = message.outcome;
}

/** Sends a protocol message, logging — never throwing — when the channel cannot take it. */
function sendTo(
  child: ChildProcess,
  taskId: string,
  message: ExecutorMessage,
  onUndelivered?: (error: Error) => void,
): void {
  const undelivered = (error: Error): void => {
    console.error(
      `task ${taskId}: \`${message.type}\` could not be sent to its process`,
      error,
    );
    onUndelivered?.(error);
  };
  // Bun leaves a process it could not spawn without a channel, or `send`.
  if (!child.connected) {
    undelivered(new Error('its IPC channel is closed'));
    return;
  }
  child.send(message, undefined, {}, (error) => {
    if (error) undelivered(error);
  });
}

function statusOf(task: Task): NonNullable<Task['status']> {
  if (task.status === undefined)
    throw new Error(`task ${task.id} has no status`);
  return task.status;
}

/** What a task records of its start; `runs` fills as it ends. */
export function taskMetadata(
  envelope: Envelope,
  admission: Admission,
): Record<string, unknown> {
  return {
    procedure: envelope.procedure,
    contractHash: envelope.contractHash,
    idempotencyKey: envelope.idempotencyKey,
    runtimeSessionId: admission.runtimeSessionId,
    attempt: admission.attempt,
    ...(admission.priorAttempt === undefined
      ? {}
      : { priorAttempt: admission.priorAttempt }),
    ...(envelope.continuityKey === undefined
      ? {}
      : { continuityKey: envelope.continuityKey }),
    metadata: envelope.metadata ?? {},
    tags: envelope.tags ?? {},
    runs: [],
  };
}

/**
 * How the task ended: why it was stopped, when that came before it reported
 * its outcome (the executor leaves `stopReason` unset otherwise), or the
 * outcome it reported.
 */
export function settledOutcome(options: {
  reported: Outcome | undefined;
  /** A task stopped for `LEASE_LOST` is not settled here: the stored loss stands. */
  stopReason: Exclude<StopReason, 'LEASE_LOST'> | undefined;
  budgetSeconds: number;
  exit: { code: number | null; signal: string | null; error?: Error };
  stderrTail: string;
}): Outcome {
  const { reported, stopReason } = options;
  switch (stopReason) {
    case 'TIMEOUT':
      return {
        state: 'TASK_STATE_FAILED',
        cause: cause(
          'TIMED_OUT',
          `the task's time budget of ${options.budgetSeconds}s ran out`,
        ),
      };
    case 'SHUTDOWN':
      return {
        state: 'TASK_STATE_FAILED',
        cause: cause('LOST', 'the container was stopped while the task ran'),
      };
    case 'START_FAILED':
      return {
        state: 'TASK_STATE_FAILED',
        cause: cause(
          'EXECUTION_ERROR',
          'the start failed after the task process was spawned, so it was stopped',
        ),
      };
    case 'CANCEL':
      return { state: 'TASK_STATE_CANCELED' };
    case undefined:
      break;
  }
  if (reported !== undefined) return reported;
  const how =
    options.exit.error === undefined
      ? `exited with ${options.exit.signal ?? `code ${options.exit.code}`}`
      : `could not start: ${options.exit.error.message}`;
  return {
    state: 'TASK_STATE_FAILED',
    cause: cause(
      'EXECUTION_ERROR',
      `the task process ${how} without reporting an outcome${options.stderrTail ? `; stderr ends: ${options.stderrTail}` : ''}`,
    ),
  };
}

function killGroup(child: ChildProcess): void {
  // The group outlives its leader while anything it started still runs.
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
