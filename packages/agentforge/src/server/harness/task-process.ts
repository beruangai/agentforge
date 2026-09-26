import { inspect } from 'node:util';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { RouterContract } from '@orpc/contract';
import { call, implement, type Router } from '@orpc/server';
import {
  contractHash,
  inputSchemaOf,
  procedureAt,
} from '#core/contract/procedures.ts';
import {
  cause,
  type Outcome,
  type PriorAttempt,
  type RunRecord,
} from '#core/contract/task.ts';
import type {
  ExecutorMessage,
  TaskInvocation,
  TaskProcessMessage,
} from '#core/task-protocol/messages.ts';
import {
  type AgentRun,
  type AgentRunSpec,
  type QueryFunction,
  runAgent,
  TaskCanceled,
  TaskFailure,
} from './kernel.ts';
import { sessionStoreFromEnvironment } from './session-store.ts';
import {
  declaredWorkingDirectories,
  type OpenWorkingDirectory,
  TaskWorkingDirectories,
  type WorkingDirectoriesOptions,
  type WorkingDirectorySpec,
} from './working-directory.ts';

/** What every procedure handler receives as its oRPC context. */
export interface TaskContext {
  readonly taskId: string;
  readonly contextId: string;
  readonly runtimeSessionId: string;
  readonly idempotencyKey: string;
  /** 1 for the first attempt under this idempotency key. */
  readonly attempt: number;
  /** How the previous attempt under this key ended, for reconciling its side effects. */
  readonly priorAttempt: PriorAttempt | undefined;
  readonly metadata: Readonly<Record<string, string>>;
  /** Aborted when the task is cancelled or times out. */
  readonly signal: AbortSignal;
  /** Runs the agent to a settled, typed answer. Throws to fail or cancel the task. */
  runAgent<Output>(spec: AgentRunSpec<Output>): Promise<AgentRun<Output>>;
  /**
   * Pulls a prefix of a working directory the deployment declared into a
   * directory of this task's own, and pushes it back as `spec.sync` says
   * before the outcome is published (ADR 0015).
   */
  openWorkingDirectory(
    spec: WorkingDirectorySpec,
  ): Promise<OpenWorkingDirectory>;
}

/** The oRPC implementer for a contract, with AgentForge's task context. */
export function implementAgent<Contract extends RouterContract>(
  contract: Contract,
) {
  return implement(contract).$context<TaskContext>();
}

/** An outcome larger than this is refused: return references instead. */
const OUTCOME_CAP_BYTES = 256 * 1024;

export interface ExecuteOptions {
  readonly contract: RouterContract;
  readonly router: Router<TaskContext>;
  readonly invocation: TaskInvocation;
  readonly signal: AbortSignal;
  readonly onRecord: (record: RunRecord) => void;
  /** Where every run's transcript is mirrored, when the deployment declares it. */
  readonly sessionStore?: SessionStore;
  /** The working directories the deployment declared; none when absent. */
  readonly workingDirectories?: WorkingDirectoriesOptions;
  /** A test seam: replaces the SDK call inside the kernel. */
  readonly query?: QueryFunction;
}

/**
 * Runs one invocation of one procedure to its outcome, its working
 * directories synced as their strategies say. Never throws: every way it can
 * end is an outcome.
 */
export async function executeProcedure(
  options: ExecuteOptions,
): Promise<Outcome> {
  const workingDirectories = new TaskWorkingDirectories({
    buckets: {},
    ...options.workingDirectories,
    taskId: options.invocation.taskId,
  });
  try {
    const outcome = await runProcedure(options, workingDirectories);
    return await synced(outcome, workingDirectories);
  } finally {
    await workingDirectories.dispose();
  }
}

/**
 * Pushes the working directories as the outcome requires. A completed task
 * whose files did not all arrive fails; a failed one keeps its own cause,
 * the sync's failure added to its message.
 */
async function synced(
  outcome: Outcome,
  workingDirectories: TaskWorkingDirectories,
): Promise<Outcome> {
  if (outcome.state === 'TASK_STATE_REJECTED') return outcome;
  const ending =
    outcome.state === 'TASK_STATE_COMPLETED'
      ? 'COMPLETED'
      : outcome.state === 'TASK_STATE_FAILED'
        ? 'FAILED'
        : 'CANCELED';
  try {
    await workingDirectories.close(ending);
    return outcome;
  } catch (error) {
    const unsynced =
      error instanceof TaskFailure
        ? error.taskCause
        : cause('WORKING_DIRECTORY_UNSYNCED', String(error));
    console.error(unsynced.message, error);
    if (outcome.state !== 'TASK_STATE_FAILED') {
      return { state: 'TASK_STATE_FAILED', cause: unsynced };
    }
    return {
      state: 'TASK_STATE_FAILED',
      cause: {
        ...outcome.cause,
        message: `${outcome.cause.message}; and ${unsynced.message}`,
      },
    };
  }
}

async function runProcedure(
  options: ExecuteOptions,
  workingDirectories: TaskWorkingDirectories,
): Promise<Outcome> {
  const { envelope } = options.invocation;
  const procedureContract = procedureAt(options.contract, envelope.procedure);
  const procedure = lookup(options.router, envelope.procedure);
  if (procedureContract === undefined || procedure === undefined) {
    return {
      state: 'TASK_STATE_REJECTED',
      reason: `this agent does not serve procedure "${envelope.procedure}"`,
    };
  }
  const expectedHash = contractHash(procedureContract);
  if (envelope.contractHash !== expectedHash) {
    return {
      state: 'TASK_STATE_REJECTED',
      reason: `procedure "${envelope.procedure}" is contract ${expectedHash} here; the caller compiled against ${envelope.contractHash}`,
    };
  }
  const input = inputSchemaOf(procedureContract).safeParse(envelope.input);
  if (!input.success) {
    return {
      state: 'TASK_STATE_REJECTED',
      reason: `input does not match procedure "${envelope.procedure}": ${input.error.message}`,
    };
  }

  const context: TaskContext = {
    taskId: options.invocation.taskId,
    contextId: options.invocation.contextId,
    runtimeSessionId: options.invocation.runtimeSessionId,
    idempotencyKey: envelope.idempotencyKey,
    attempt: options.invocation.attempt,
    priorAttempt: options.invocation.priorAttempt,
    metadata: envelope.metadata ?? {},
    signal: options.signal,
    runAgent: (spec) =>
      runAgent(
        spec,
        {
          signal: options.signal,
          onRecord: options.onRecord,
          ...(options.sessionStore === undefined
            ? {}
            : { sessionStore: options.sessionStore }),
        },
        options.query,
      ),
    openWorkingDirectory: (spec) => workingDirectories.open(spec),
  };
  try {
    const output: unknown = await call(procedure, input.data, {
      context,
      signal: options.signal,
    });
    const bytes = Buffer.byteLength(JSON.stringify(output ?? null));
    if (bytes > OUTCOME_CAP_BYTES) {
      return {
        state: 'TASK_STATE_FAILED',
        cause: cause(
          'OUTPUT_TOO_LARGE',
          `the outcome is ${bytes} bytes; the cap is ${OUTCOME_CAP_BYTES}`,
        ),
      };
    }
    return { state: 'TASK_STATE_COMPLETED', output };
  } catch (error) {
    const outcome = outcomeOf(error, options.signal);
    if (outcome.state === 'TASK_STATE_FAILED') {
      // Whole, in the container log; the cause carries a cut of it.
      console.error(
        `task ${options.invocation.taskId} failed: ${outcome.cause.code}`,
        error,
      );
    }
    return outcome;
  }
}

function outcomeOf(error: unknown, signal: AbortSignal): Outcome {
  if (error instanceof TaskCanceled || signal.aborted) {
    return { state: 'TASK_STATE_CANCELED' };
  }
  if (error instanceof TaskFailure) {
    return { state: 'TASK_STATE_FAILED', cause: error.taskCause };
  }
  // oRPC wraps a thrown error; the kernel's own failures are found in the chain.
  const nested = error instanceof Error ? error.cause : undefined;
  if (nested instanceof TaskFailure) {
    return { state: 'TASK_STATE_FAILED', cause: nested.taskCause };
  }
  if (nested instanceof TaskCanceled) return { state: 'TASK_STATE_CANCELED' };
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code =
    error instanceof Error &&
    'code' in error &&
    error.code === 'INTERNAL_SERVER_ERROR' &&
    /output/i.test(error.message)
      ? 'OUTPUT_INVALID'
      : 'EXECUTION_ERROR';
  return {
    state: 'TASK_STATE_FAILED',
    cause: cause(code, message, { stackTrace: inspect(error, { depth: 8 }) }),
  };
}

function lookup(
  router: Router<TaskContext>,
  path: string,
): Parameters<typeof call>[0] | undefined {
  let node: unknown = router;
  for (const key of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'object' && node !== null && '~orpc' in node
    ? (node as Parameters<typeof call>[0])
    : undefined;
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
  const send = process.send?.bind(process);
  if (send === undefined) {
    throw new Error(
      'runTaskProcess runs only in a process the AgentForge runtime spawned; there is no IPC channel',
    );
  }
  const emit = (message: TaskProcessMessage): Promise<void> =>
    new Promise((resolve, reject) =>
      send(message, undefined, {}, (error) =>
        error ? reject(error) : resolve(),
      ),
    );
  const controller = new AbortController();
  const sessionStore = sessionStoreFromEnvironment();
  const buckets = declaredWorkingDirectories();
  let started = false;
  process.on('message', (message: ExecutorMessage) => {
    if (message.type === 'cancel') {
      controller.abort();
      return;
    }
    if (started) return;
    started = true;
    void executeProcedure({
      contract: options.contract,
      router: options.router,
      invocation: message.invocation,
      signal: controller.signal,
      onRecord: (record) => void emit({ type: 'record', record }),
      ...(sessionStore === undefined ? {} : { sessionStore }),
      workingDirectories: { buckets },
    })
      .then((outcome) => emit({ type: 'outcome', outcome }))
      .then(
        () => process.exit(0),
        (error: unknown) => {
          console.error('the task process could not report its outcome', error);
          process.exit(1);
        },
      );
  });
  process.on('disconnect', () => {
    if (!controller.signal.aborted) controller.abort();
  });
}
