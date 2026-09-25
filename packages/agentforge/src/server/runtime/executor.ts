import { type ChildProcess, spawn } from 'node:child_process';
import type { Task } from '@a2a-js/sdk';
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import type { Envelope } from '#core/contract/envelope.ts';
import {
  cause,
  type Outcome,
  type PriorAttempt,
  type RunRecord,
} from '#core/contract/task.ts';
import {
  type ExecutorMessage,
  TASK_PROCESS_ENVIRONMENT_VARIABLE,
  type TaskInvocation,
  type TaskProcessMessage,
} from '#core/task-protocol/messages.ts';
import { finishedTask, newTask, readEnvelope, TaskState } from './a2a-task.ts';
import type { DynamoDBTaskStore } from './task-store.ts';

/** What the gateway decided about a start, handed to the executor on the message. */
export interface Admission {
  readonly runtimeSessionId: string;
  readonly attempt: number;
  readonly priorAttempt: PriorAttempt | undefined;
}
export const ADMISSION_METADATA_KEY = 'agentforge.admission';

export interface ExecutorConfig {
  /** The command that starts a task process: the consumer's task entry. */
  readonly taskCommand: readonly string[];
  readonly defaultTimeBudgetSeconds: number;
  /** How long a stopping task process gets before its process group is killed. */
  readonly graceMilliseconds: number;
  readonly store: DynamoDBTaskStore;
}

type StopReason = 'cancel' | 'timeout' | 'shutdown';

interface LiveTask {
  readonly child: ChildProcess;
  readonly continuityKey: string | undefined;
  readonly finished: Promise<void>;
  stopReason: StopReason | undefined;
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

  constructor(private readonly config: ExecutorConfig) {}

  get liveCount(): number {
    return this.#live.size;
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

    const invocation: TaskInvocation = {
      taskId,
      contextId,
      runtimeSessionId: admission.runtimeSessionId,
      attempt: admission.attempt,
      priorAttempt: admission.priorAttempt,
      envelope,
    };
    const { promise: finished, resolve: markFinished } =
      Promise.withResolvers<void>();
    const records: RunRecord[] = [];
    let reported: Outcome | undefined;
    let stderrTail = '';

    const child = spawn(
      this.config.taskCommand[0] ?? '',
      this.config.taskCommand.slice(1),
      {
        stdio: ['ignore', 'inherit', 'pipe', 'ipc'],
        detached: true,
        serialization: 'json',
        env: { ...process.env, [TASK_PROCESS_ENVIRONMENT_VARIABLE]: '1' },
      },
    );
    const live: LiveTask = {
      child,
      continuityKey: envelope.continuityKey,
      finished,
      stopReason: undefined,
    };
    this.#live.set(taskId, live);

    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      stderrTail = (stderrTail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    child.on('message', (received: TaskProcessMessage) => {
      if (received.type === 'record') records.push(received.record);
      if (received.type === 'outcome') reported = received.outcome;
    });
    const exited = new Promise<{
      code: number | null;
      signal: string | null;
      error?: Error;
    }>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', (error) =>
        resolve({ code: null, signal: null, error }),
      );
    });
    child.send({ type: 'run', invocation } satisfies ExecutorMessage);

    eventBus.publish(
      AgentEvent.task({
        ...submitted,
        status: { ...statusOf(submitted), state: TaskState.TASK_STATE_WORKING },
      }),
    );

    const lease = setInterval(() => {
      this.config.store.renewLease(taskId).catch((error: unknown) => {
        console.error(`task ${taskId}: the lease could not be renewed`, error);
      });
    }, LEASE_RENEWAL_MILLISECONDS);
    const budgetSeconds =
      envelope.timeBudgetSeconds ?? this.config.defaultTimeBudgetSeconds;
    const budget = setTimeout(() => {
      void this.stop(taskId, 'timeout');
    }, budgetSeconds * 1000);

    try {
      const exit = await exited;
      const outcome = settledOutcome({
        reported,
        stopReason: live.stopReason,
        budgetSeconds,
        exit,
        stderrTail,
      });
      const finished = finishedTask(submitted, outcome, { runs: records });
      // Stored before it is published, so a caller reading the store after a
      // cancel or a poll sees the end, not the SDK's write still in flight.
      await this.config.store.save(finished);
      eventBus.publish(AgentEvent.task(finished));
    } finally {
      clearInterval(lease);
      clearTimeout(budget);
      this.#live.delete(taskId);
      killGroup(child);
      eventBus.finished();
      markFinished();
    }
  }

  async cancelTask(taskId: string): Promise<void> {
    await this.stop(taskId, 'cancel');
  }

  /**
   * Asks the task process to stop, and kills its process group after the
   * grace period whatever it is doing. Resolves once the task has finished.
   */
  async stop(taskId: string, reason: StopReason): Promise<void> {
    const live = this.#live.get(taskId);
    if (live === undefined) return;
    live.stopReason ??= reason;
    if (live.child.connected) {
      live.child.send({ type: 'cancel' } satisfies ExecutorMessage);
    }
    const kill = setTimeout(
      () => killGroup(live.child),
      this.config.graceMilliseconds,
    );
    await live.finished;
    clearTimeout(kill);
  }

  /** On SIGTERM: every live task stops, and is recorded lost rather than left to its lease. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.#live.keys()].map((taskId) => this.stop(taskId, 'shutdown')),
    );
  }
}

function statusOf(task: Task): NonNullable<Task['status']> {
  if (task.status === undefined)
    throw new Error(`task ${task.id} has no status`);
  return task.status;
}

function taskMetadata(
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
  };
}

/** How the task ended, from what it reported and why it was stopped. */
export function settledOutcome(options: {
  reported: Outcome | undefined;
  stopReason: StopReason | undefined;
  budgetSeconds: number;
  exit: { code: number | null; signal: string | null; error?: Error };
  stderrTail: string;
}): Outcome {
  const { reported, stopReason } = options;
  if (stopReason === 'timeout') {
    return {
      state: 'TASK_STATE_FAILED',
      cause: cause(
        'TIMED_OUT',
        `the task's time budget of ${options.budgetSeconds}s ran out`,
      ),
    };
  }
  if (stopReason === 'shutdown') {
    return {
      state: 'TASK_STATE_FAILED',
      cause: cause('LOST', 'the container was stopped while the task ran'),
    };
  }
  if (stopReason === 'cancel') return { state: 'TASK_STATE_CANCELED' };
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
