import { randomUUIDv7 } from 'node:crypto';
import type {
  AnyProcedureContract,
  InferSchemaInput,
  InferSchemaOutput,
  ProcedureContract,
  RouterContract,
} from '@orpc/contract';
import type { Envelope } from '#core/contract/envelope.ts';
import {
  contractHash,
  outputSchemaOf,
  procedureAt,
  timeBudgetOf,
} from '#core/contract/procedures.ts';
import {
  type Cause,
  outcomeSchema,
  type RunRecord,
  type TaskState,
  taskStates,
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

interface WireTask {
  id: string;
  contextId: string;
  status?: { state?: string };
  artifacts?: { artifactId?: string; parts?: { data?: unknown }[] }[];
  metadata?: { attempt?: number; runs?: RunRecord[] };
}

/** A wire task as the caller sees it; the output is parsed against the caller's own contract. */
function taskView<Output>(
  value: unknown,
  parseOutput: ((value: unknown) => Output) | undefined,
): TaskView<Output> {
  const task = value as WireTask;
  const state = task.status?.state as TaskState | undefined;
  if (state === undefined || !taskStates.includes(state)) {
    throw new Error(`the agent answered a task in state ${String(state)}`);
  }
  const base: TaskViewBase = {
    taskId: task.id,
    contextId: task.contextId,
    attempt: task.metadata?.attempt ?? 1,
    runs: task.metadata?.runs ?? [],
  };
  if (state === 'TASK_STATE_SUBMITTED' || state === 'TASK_STATE_WORKING') {
    return { ...base, state };
  }
  const data = task.artifacts?.find(
    (artifact) => artifact.artifactId === 'outcome',
  )?.parts?.[0]?.data;
  const outcome = outcomeSchema.parse(data);
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
  const interval = options.pollIntervalMilliseconds ?? 5_000;
  while (
    current.state === 'TASK_STATE_SUBMITTED' ||
    current.state === 'TASK_STATE_WORKING'
  ) {
    options.signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      options.signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        },
        { once: true },
      );
    });
    current = await procedure.GetTask(current.taskId, options);
    options.onPoll?.(current);
  }
  return current as TerminalTaskView<Output>;
}
