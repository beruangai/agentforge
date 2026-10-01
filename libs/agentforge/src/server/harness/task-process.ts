import { inspect } from 'node:util';
import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { RouterContract } from '@orpc/contract';
import {
  call,
  DecoratedProcedure,
  implement,
  ORPCError,
  type Router,
  unlazy,
  ValidationError,
} from '@orpc/server';
import { z } from 'zod';
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
import {
  ExecutorMessageSchema,
  type TaskInvocation,
  type TaskProcessMessage,
} from '#core/task-protocol/messages.ts';
import { TASK_OUTPUT_CAP_BYTES } from '#core/task-table.ts';
import type {
  MountedFilesystem,
  MountLifecycle,
} from './filesystem/filesystem.ts';
import { mountRegisteredFilesystems } from './filesystem/registry.ts';
import {
  type AgentRun,
  type AgentRunSpec,
  type QueryFunction,
  runAgent,
  TaskCanceled,
  TaskFailure,
} from './kernel.ts';
import { sessionStoreFromEnvironment } from './session-store.ts';

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
  /** The filesystems mounted for this procedure, by the name it registered each under (ADR 0015). */
  readonly filesystems: Readonly<Record<string, MountedFilesystem>>;
  /** Every mounted filesystem's baseline permissions, merged; no agent gets them unless the handler gives them. */
  readonly filesystemPermissions: { readonly allow: readonly string[] };
  /** Every mounted filesystem's `localPath`, to give a run as its `additionalDirectories`. */
  readonly filesystemDirectories: readonly string[];
}

/** The oRPC implementer for a contract, with AgentForge's task context. */
export function implementAgent<Contract extends RouterContract>(
  contract: Contract,
) {
  return implement(contract).$context<TaskContext>();
}

export interface ExecuteOptions {
  readonly contract: RouterContract;
  readonly router: Router<TaskContext>;
  readonly invocation: TaskInvocation;
  readonly signal: AbortSignal;
  readonly onRecord: (record: RunRecord) => void;
  /** Where every run's transcript is mirrored, when the deployment declares it. */
  readonly sessionStore?: SessionStore;
  /** A test seam: replaces the SDK call inside the kernel. */
  readonly query?: QueryFunction;
}

/**
 * Runs one invocation of one procedure to its outcome, its filesystems
 * mounted before the handler and unmounted once the outcome is known. Never
 * throws: every way it can end is an outcome.
 */
export async function executeProcedure(
  options: ExecuteOptions,
): Promise<Outcome> {
  const lifecycles: MountLifecycle[] = [];
  const outcome = await runProcedure(options, lifecycles);
  return capCause(
    options.invocation.taskId,
    await unmountAll(outcome, lifecycles),
  );
}

/**
 * A failed outcome over the output record's cap loses its cause's payload,
 * logged whole here, and says so.
 */
function capCause(taskId: string, outcome: Outcome): Outcome {
  if (
    outcome.state !== 'TASK_STATE_FAILED' ||
    outcome.cause.payload === undefined
  ) {
    return outcome;
  }
  const bytes = Buffer.byteLength(JSON.stringify(outcome.cause));
  if (bytes <= TASK_OUTPUT_CAP_BYTES) return outcome;
  const { payload, ...kept } = outcome.cause;
  console.error(
    `task ${taskId}: the ${kept.code} cause is ${bytes} bytes, over the cap of ${TASK_OUTPUT_CAP_BYTES}; its payload, dropped from the cause:`,
    JSON.stringify(payload),
  );
  return {
    state: 'TASK_STATE_FAILED',
    cause: {
      ...kept,
      message: `${kept.message}; the payload was dropped: the cause was ${bytes} bytes, and the cap is ${TASK_OUTPUT_CAP_BYTES}. The container log holds it whole`,
    },
  };
}

/**
 * Unmounts every filesystem, each pushing if its `pushOn` has the task's state. A task
 * that did not fail, whose filesystems did not all unmount, fails; a failed
 * one keeps its own cause, the unmount's failure added to its message.
 */
async function unmountAll(
  outcome: Outcome,
  lifecycles: readonly MountLifecycle[],
): Promise<Outcome> {
  if (outcome.state === 'TASK_STATE_REJECTED') return outcome;
  const failures = (
    await Promise.allSettled(
      lifecycles.map((lifecycle) => lifecycle.unmount(outcome.state)),
    )
  ).flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (failures.length === 0) return outcome;
  const causes = failures.map((error: unknown) => {
    console.error('a filesystem did not unmount', error);
    return error instanceof TaskFailure
      ? error.taskCause
      : cause('EXECUTION_ERROR', String(error));
  });
  const message = causes.map((unmount) => unmount.message).join('; ');
  if (outcome.state !== 'TASK_STATE_FAILED') {
    return {
      state: 'TASK_STATE_FAILED',
      cause: { ...(causes[0] as (typeof causes)[number]), message },
    };
  }
  return {
    state: 'TASK_STATE_FAILED',
    cause: {
      ...outcome.cause,
      message: `${outcome.cause.message}; and ${message}`,
    },
  };
}

async function runProcedure(
  options: ExecuteOptions,
  lifecycles: MountLifecycle[],
): Promise<Outcome> {
  const { envelope } = options.invocation;
  const procedureContract = procedureAt(options.contract, envelope.procedure);
  const registered = lookup(options.router, envelope.procedure);
  if (procedureContract === undefined || registered === undefined) {
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
    // Set by the lifecycle middleware, which runs just before the handler.
    filesystems: {},
    filesystemPermissions: { allow: [] },
    filesystemDirectories: [],
  };
  // Appended last, so it runs innermost: after every registration.
  try {
    const { default: leaf } = await unlazy(registered);
    const procedure = new DecoratedProcedure(leaf['~orpc']).use(
      mountRegisteredFilesystems(lifecycles),
    );
    const output: unknown = await call(procedure, input.data, {
      context,
      signal: options.signal,
    });
    const bytes = Buffer.byteLength(JSON.stringify(output ?? null));
    if (bytes > TASK_OUTPUT_CAP_BYTES) {
      return {
        state: 'TASK_STATE_FAILED',
        cause: cause(
          'OUTPUT_TOO_LARGE',
          `the outcome is ${bytes} bytes; the cap is ${TASK_OUTPUT_CAP_BYTES}`,
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
  // oRPC's own validation: the input, refused before any work, or the
  // handler's output, which failed the contract.
  if (error instanceof ORPCError && nested instanceof ValidationError) {
    const issues = z.prettifyError(
      new z.ZodError([...nested.issues] as z.core.$ZodIssue[]),
    );
    if (error.code === 'BAD_REQUEST') {
      return {
        state: 'TASK_STATE_REJECTED',
        reason: `input does not match the procedure: ${issues}`,
      };
    }
    return {
      state: 'TASK_STATE_FAILED',
      cause: cause(
        'OUTPUT_INVALID',
        `the procedure's output does not match its contract: ${issues}`,
        {
          payload: nested.invalidData,
          stackTrace: inspect(error, { depth: 8 }),
        },
      ),
    };
  }
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return {
    state: 'TASK_STATE_FAILED',
    cause: cause('EXECUTION_ERROR', message, {
      stackTrace: inspect(error, { depth: 8 }),
    }),
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
  let started = false;
  process.on('message', (received: unknown) => {
    const parsed = ExecutorMessageSchema.safeParse(received);
    if (!parsed.success) {
      // The executor and this process are one version: anything else is a bug.
      console.error(
        `the task process received a message outside the protocol: ${z.prettifyError(parsed.error)}`,
      );
      process.exit(1);
    }
    const message = parsed.data;
    if (message.type === 'cancel') {
      controller.abort();
      return;
    }
    if (started) {
      console.error(
        `the task process received a second run, for task ${message.invocation.taskId}, and ignored it`,
      );
      return;
    }
    started = true;
    const { taskId } = message.invocation;
    void executeProcedure({
      contract: options.contract,
      router: options.router,
      invocation: message.invocation,
      signal: controller.signal,
      onRecord: (record) => {
        emit({ type: 'record', record }).catch((error: unknown) => {
          console.error(
            `task ${taskId}: a run record could not be sent to the executor`,
            error,
          );
        });
      },
      ...(sessionStore === undefined ? {} : { sessionStore }),
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
