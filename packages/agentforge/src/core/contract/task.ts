import { z } from 'zod';

/**
 * A task's state is A2A 1.0's, verbatim. AgentForge adds no state of its own;
 * a failed task carries a typed cause instead.
 */
export const taskStates = [
  'TASK_STATE_SUBMITTED',
  'TASK_STATE_WORKING',
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
] as const;
export type TaskState = (typeof taskStates)[number];

export const terminalTaskStates: ReadonlySet<TaskState> = new Set([
  'TASK_STATE_COMPLETED',
  'TASK_STATE_FAILED',
  'TASK_STATE_CANCELED',
  'TASK_STATE_REJECTED',
]);

export function isTerminal(state: TaskState): boolean {
  return terminalTaskStates.has(state);
}

/** Why a task failed. The code is what a caller branches on. */
export const causeCodes = [
  /** The agent's answer did not conform, or there was none. `payload` holds what arrived. */
  'OUTPUT_INVALID',
  /** The outcome conformed but exceeds the record's cap; return references instead. */
  'OUTPUT_TOO_LARGE',
  /** `maxTurns` or `maxBudgetUsd` ran out. */
  'BUDGET_EXHAUSTED',
  /** The task's own time budget ran out; the executor stopped it. */
  'TIMED_OUT',
  /** The container died or was stopped mid-run; side effects may have happened. */
  'LOST',
  /** The subscription's usage limit; `retryAfter` is when it resets. */
  'USAGE_LIMITED',
  /** The subscription token was refused; an operator must act. */
  'CREDENTIAL_EXPIRED',
  /** The model provider failed transiently. */
  'PROVIDER_TRANSIENT',
  /** Anything else: the procedure, the harness or the SDK threw. */
  'EXECUTION_ERROR',
] as const;
export type CauseCode = (typeof causeCodes)[number];

export const causeSchema = z.object({
  code: z.enum(causeCodes),
  message: z.string(),
  /** Whether running a new attempt could succeed. */
  retryable: z.boolean(),
  /** ISO time before which a retry is pointless. */
  retryAfter: z.string().optional(),
  /** What the agent produced, when it did not conform. */
  payload: z.unknown().optional(),
});
export type Cause = z.infer<typeof causeSchema>;

const retryableByCode: Record<CauseCode, boolean> = {
  OUTPUT_INVALID: false,
  OUTPUT_TOO_LARGE: false,
  BUDGET_EXHAUSTED: false,
  TIMED_OUT: false,
  LOST: true,
  USAGE_LIMITED: true,
  CREDENTIAL_EXPIRED: false,
  PROVIDER_TRANSIENT: true,
  EXECUTION_ERROR: false,
};

export function cause(
  code: CauseCode,
  message: string,
  extra: Partial<Pick<Cause, 'retryAfter' | 'payload'>> = {},
): Cause {
  return { code, message, retryable: retryableByCode[code], ...extra };
}

/** How a task ended, as the task process reports it and the artifact carries it. */
export const outcomeSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('TASK_STATE_COMPLETED'), output: z.unknown() }),
  z.object({ state: z.literal('TASK_STATE_FAILED'), cause: causeSchema }),
  z.object({ state: z.literal('TASK_STATE_CANCELED') }),
  z.object({ state: z.literal('TASK_STATE_REJECTED'), reason: z.string() }),
]);
export type Outcome = z.infer<typeof outcomeSchema>;

/** What one agent run recorded (§REQ601). */
export const runRecordSchema = z.object({
  prompt: z.unknown(),
  options: z.record(z.string(), z.unknown()),
  sessionId: z.string().optional(),
  numberOfTurns: z.number().optional(),
  totalCostUsd: z.number().optional(),
  modelUsage: z.record(z.string(), z.unknown()).optional(),
  durationMilliseconds: z.number().optional(),
  terminalReason: z.string().optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** The attempt before this one under the same idempotency key, if any. */
export const priorAttemptSchema = z.object({
  taskId: z.string(),
  state: z.enum(taskStates),
  cause: causeSchema.optional(),
});
export type PriorAttempt = z.infer<typeof priorAttemptSchema>;
