import { randomUUIDv7 } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  AnyProcedureContract,
  InferSchemaInput,
  InferSchemaOutput,
  ProcedureContract,
  RouterContract,
} from '@orpc/contract';
import { z } from 'zod';
import type { Envelope } from '#core/contract/envelope.ts';
import {
  contractHash,
  outputSchemaOf,
  procedureAt,
  timeBudgetOf,
} from '#core/contract/procedures.ts';
import {
  type Cause,
  outcomeOfArtifacts,
  type RunRecord,
  RunRecordSchema,
  TaskStateEnum,
} from '#core/contract/task.ts';
import type { Transport } from './transport.ts';

/** Routes a call to the container serving this runtime session. Required on every call. */
export interface Routed {
  readonly runtimeSessionId: string;
}

/** What only a start needs: the key naming one logical execution (§REQ305). */
export interface Starting extends Routed {
  readonly idempotencyKey: string;
  /** A2A's conversation id; a uuid7 is minted when none is given. */
  readonly contextId?: string;
  readonly continuityKey?: string;
  readonly timeBudgetSeconds?: number;
  readonly metadata?: Record<string, string>;
  readonly tags?: Record<string, string>;
}

interface TaskViewBase {
  readonly taskId: string;
  readonly contextId: string;
  readonly attempt: number;
  readonly runs: readonly RunRecord[];
}

/** A task as `GetTask` answers it: the output exists only on the completed branch. */
export type TaskView<Output> = TaskViewBase &
  (
    | { readonly state: 'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING' }
    | { readonly state: 'TASK_STATE_COMPLETED'; readonly output: Output }
    | { readonly state: 'TASK_STATE_FAILED'; readonly cause: Cause }
    | { readonly state: 'TASK_STATE_CANCELED' }
    | { readonly state: 'TASK_STATE_REJECTED'; readonly reason: string }
  );

export interface ProcedureClient<Input, Output> {
  /** Starts the procedure — or attaches to the attempt its idempotency key already names. */
  SendMessage(input: Input, context: Starting): Promise<TaskView<Output>>;
  GetTask(taskId: string, context: Routed): Promise<TaskView<Output>>;
}

export type AgentForgeClient<Contract extends RouterContract> =
  ContractClient<Contract> & {
    /** Cancels a task; answers the task as it ended. */
    CancelTask(taskId: string, context: Routed): Promise<TaskView<unknown>>;
  };

type ContractClient<Contract> =
  Contract extends ProcedureContract<infer Input, infer Output, infer _Errors>
    ? ProcedureClient<InferSchemaInput<Input>, InferSchemaOutput<Output>>
    : { readonly [Key in keyof Contract]: ContractClient<Contract[Key]> };

/**
 * The typed client for a contract (§REQ101): every procedure's `SendMessage`
 * and `GetTask`, and `CancelTask` at the root. Nothing is written per
 * procedure; a wrong name or shape is a compile error.
 */
export function createClient<Contract extends RouterContract>(
  contract: Contract,
  transport: Transport,
): AgentForgeClient<Contract> {
  const cancelTask = async (
    taskId: string,
    context: Routed,
  ): Promise<TaskView<unknown>> =>
    taskView(
      await transport.call(
        'CancelTask',
        { id: taskId },
        context.runtimeSessionId,
      ),
      undefined,
    );

  function node(path: readonly string[]): unknown {
    const dotted = path.join('.');
    const procedure =
      path.length === 0 ? undefined : procedureAt(contract, dotted);
    if (procedure !== undefined)
      return procedureClient(dotted, procedure, transport);
    return new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property !== 'string') return undefined;
          if (path.length === 0 && property === 'CancelTask') return cancelTask;
          if (property === 'then') return undefined;
          return node([...path, property]);
        },
      },
    );
  }
  return node([]) as AgentForgeClient<Contract>;
}

function procedureClient(
  path: string,
  procedure: AnyProcedureContract,
  transport: Transport,
): ProcedureClient<unknown, unknown> {
  const hash = contractHash(procedure);
  const output = outputSchemaOf(procedure);
  const declaredTimeBudgetSeconds = timeBudgetOf(procedure);
  return {
    async SendMessage(input, context) {
      const timeBudgetSeconds =
        context.timeBudgetSeconds ?? declaredTimeBudgetSeconds;
      const envelope: Envelope = {
        procedure: path,
        contractHash: hash,
        input,
        idempotencyKey: context.idempotencyKey,
        ...(context.continuityKey === undefined
          ? {}
          : { continuityKey: context.continuityKey }),
        ...(timeBudgetSeconds === undefined ? {} : { timeBudgetSeconds }),
        ...(context.metadata === undefined
          ? {}
          : { metadata: context.metadata }),
        ...(context.tags === undefined ? {} : { tags: context.tags }),
      };
      const result = await transport.call(
        'SendMessage',
        {
          message: {
            messageId: randomUUIDv7(),
            role: 'ROLE_USER',
            contextId: context.contextId ?? randomUUIDv7(),
            parts: [{ data: envelope }],
          },
          configuration: { returnImmediately: true },
        },
        context.runtimeSessionId,
      );
      const task = (result as { task?: unknown }).task;
      if (task === undefined)
        throw new Error(`SendMessage to ${path} answered no task`);
      return taskView(task, (value) => output.parse(value));
    },
    async GetTask(taskId, context) {
      return taskView(
        await transport.call(
          'GetTask',
          { id: taskId },
          context.runtimeSessionId,
        ),
        (value) => output.parse(value),
      );
    },
  };
}

/** A task as A2A 1.0 JSON carries it, to what the client reads of it. */
const WireTaskSchema = z.object({
  id: z.string(),
  contextId: z.string(),
  status: z.object({ state: TaskStateEnum }),
  artifacts: z.unknown(),
  metadata: z.object({
    attempt: z.number().int().positive(),
    runs: z.array(RunRecordSchema),
  }),
});

/** A wire task as the caller sees it; the output is parsed against the caller's own contract. */
function taskView<Output>(
  value: unknown,
  parseOutput: ((value: unknown) => Output) | undefined,
): TaskView<Output> {
  const parsed = WireTaskSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `the agent answered a task the client cannot read: ${z.prettifyError(parsed.error)}`,
    );
  }
  const task = parsed.data;
  const state = task.status.state;
  const base: TaskViewBase = {
    taskId: task.id,
    contextId: task.contextId,
    attempt: task.metadata.attempt,
    runs: task.metadata.runs,
  };
  if (state === 'TASK_STATE_SUBMITTED' || state === 'TASK_STATE_WORKING') {
    return { ...base, state };
  }
  const outcome = outcomeOfArtifacts(task.artifacts);
  if (outcome === undefined) {
    throw new Error(`task ${task.id} ended ${state} without an outcome`);
  }
  switch (outcome.state) {
    case 'TASK_STATE_COMPLETED':
      return {
        ...base,
        state: outcome.state,
        output:
          parseOutput === undefined
            ? (outcome.output as Output)
            : parseOutput(outcome.output),
      };
    case 'TASK_STATE_FAILED':
      return { ...base, state: outcome.state, cause: outcome.cause };
    case 'TASK_STATE_REJECTED':
      return { ...base, state: outcome.state, reason: outcome.reason };
    case 'TASK_STATE_CANCELED':
      return { ...base, state: outcome.state };
  }
}

export type TerminalTaskView<Output> = Exclude<
  TaskView<Output>,
  { state: 'TASK_STATE_SUBMITTED' | 'TASK_STATE_WORKING' }
>;

export const DEFAULT_POLL_INTERVAL_MILLISECONDS = 5_000;

/**
 * Polls `GetTask` until the task ends (§REQ301). Polling is the only way to
 * wait; `onPoll` is where a caller heartbeats.
 */
export async function awaitTask<Output>(
  procedure: ProcedureClient<unknown, Output> | ProcedureClient<never, Output>,
  task: TaskView<Output>,
  options: Routed & {
    readonly pollIntervalMilliseconds?: number;
    readonly signal?: AbortSignal;
    readonly onPoll?: (task: TaskView<Output>) => void;
  },
): Promise<TerminalTaskView<Output>> {
  let current = task;
  const interval =
    options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
  while (
    current.state === 'TASK_STATE_SUBMITTED' ||
    current.state === 'TASK_STATE_WORKING'
  ) {
    options.signal?.throwIfAborted();
    await delay(
      interval,
      undefined,
      options.signal === undefined ? {} : { signal: options.signal },
    ).catch((error: unknown) => {
      // Aborted: throw the signal's reason, as before the wait.
      options.signal?.throwIfAborted();
      throw error;
    });
    current = await procedure.GetTask(current.taskId, options);
    options.onPoll?.(current);
  }
  return current as TerminalTaskView<Output>;
}
